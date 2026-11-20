/* Lance un vrai serveur sur un port libre, avec une base temporaire, et parcourt l'API. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(path.join(tmpdir(), "kosmy-board-test-"));
let server, setupCode;

before(async () => {
  server = spawn(process.execPath, ["server/index.js"], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, PUBLIC_URL: BASE } });
  setupCode = await new Promise((resolve, reject) => {
    let out = "";
    server.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/);
      if (m) resolve(m[0]);
    });
    server.on("exit", () => reject(new Error(out)));
  });
});
after(async () => {
  const exited = new Promise((r) => server.once("exit", r));
  server.kill();
  await exited;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Petit client avec son propre cookie de session. */
function client() {
  let cookie = "";
  return async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { Origin: BASE, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
}

const admin = client();
const member = client();
const stranger = client();

test("première configuration protégée par le code", async () => {
  assert.equal((await stranger("GET", "/api/state")).body.setupNeeded, true);
  assert.equal((await admin("POST", "/api/setup", { code: "0000-0000-0000", name: "A", email: "a@x.fr", password: "motdepasse-123" })).body.error, "setup_code");
  assert.equal((await admin("POST", "/api/setup", { code: setupCode, name: "A", email: "a@x.fr", password: "court" })).body.error, "password_short");
  assert.equal((await admin("POST", "/api/setup", { code: setupCode, name: "A", email: "a@x.fr", password: "motdepasse-123" })).status, 201);
  assert.equal((await stranger("POST", "/api/setup", { code: setupCode, name: "B", email: "b@x.fr", password: "motdepasse-123" })).status, 409);
  const st = (await admin("GET", "/api/state")).body;
  assert.equal(st.user.role, "admin");
  assert.equal(st.setupNeeded, false);
});

test("les en-têtes de sécurité sont présents", async () => {
  const r = await fetch(BASE + "/");
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await fetch(BASE + "/../server/auth.js")).status, 404);
});

test("les requêtes d'un autre site sont refusées", async () => {
  const r = await admin("POST", "/api/spaces", { name: "X", base: "x.fr", path: "/" }, { Origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("espaces : ajout, validation, modification, ouverture, suppression", async () => {
  const add = await admin("POST", "/api/spaces", { appId: "kanby", name: "Kanby", base: "Kanby.fr", path: "admin" });
  assert.equal(add.status, 201);
  assert.equal(add.body.space.base, "https://kanby.fr");
  assert.equal(add.body.space.path, "/admin");
  const id = add.body.space.id;
  assert.equal((await admin("POST", "/api/spaces", { name: "X", base: "javascript:alert(1)", path: "/" })).body.error, "invalid");
  assert.equal((await admin("POST", "/api/spaces", { name: "X", base: "x.fr", path: "//evil.com" })).body.error, "path");
  assert.equal((await admin("POST", "/api/spaces", { name: "", base: "x.fr", path: "/" })).body.error, "name");
  assert.equal((await admin("PUT", `/api/spaces/${id}`, { appId: "kanby", name: "Kanby perso", base: "kanby.fr", path: "/admin" })).body.space.name, "Kanby perso");
  assert.ok((await admin("POST", `/api/spaces/${id}/opened`, {})).body.openedAt > 0);
  assert.equal((await stranger("GET", "/api/spaces")).status, 401);
  assert.equal((await admin("DELETE", `/api/spaces/${id}`)).status, 200);
  assert.equal((await admin("DELETE", `/api/spaces/${id}`)).status, 404);
});

test("import / export compatibles avec Kosmy Mobile", async () => {
  const mobile = [
    { id: "m1", appId: "dashy", name: "Dashy", base: "https://dashy.fr", path: "/", addedAt: 1700000000000, openedAt: 1700000100000 },
    { id: "m2", appId: null, name: "Autre", base: "https://autre.fr", path: "/admin", addedAt: 1700000000000 },
    { nope: true },
  ];
  assert.deepEqual((await admin("POST", "/api/spaces/import", mobile)).body, { added: 2, skipped: 0, invalid: 1 });
  assert.deepEqual((await admin("POST", "/api/spaces/import", { spaces: mobile })).body, { added: 0, skipped: 2, invalid: 1 });
  const exp = await admin("GET", "/api/spaces/export");
  assert.match(exp.headers.get("content-disposition"), /attachment/);
  assert.equal(exp.body.format, "kosmy.admin.v1");
  assert.deepEqual(exp.body.spaces.find((s) => s.id === "m1"), mobile[0]);
});

test("invitations : membre, espaces séparés, droits", async () => {
  const inv = await admin("POST", "/api/invites", { role: "member" });
  const token = inv.body.url.split("/").pop();
  assert.equal((await member("POST", "/api/invites/check", { token })).body.valid, true);
  assert.equal((await member("POST", "/api/invites/accept", { token, name: "M", email: "m@x.fr", password: "motdepasse-456" })).status, 201);
  assert.equal((await stranger("POST", "/api/invites/accept", { token, name: "N", email: "n@x.fr", password: "motdepasse-456" })).status, 410);
  assert.deepEqual((await member("GET", "/api/spaces")).body.spaces, []);
  assert.equal((await member("GET", "/api/users")).status, 403);
  assert.equal((await member("POST", "/api/invites", { role: "admin" })).status, 403);
  const users = (await admin("GET", "/api/users")).body.users;
  assert.equal(users.length, 2);
});

test("connexion : mauvais mot de passe puis blocage", async () => {
  const c = client();
  for (let i = 0; i < 5; i++) assert.equal((await c("POST", "/api/login", { email: "m@x.fr", password: "faux" })).body.error, "login_failed");
  const locked = await c("POST", "/api/login", { email: "m@x.fr", password: "motdepasse-456" });
  assert.equal(locked.status, 429);
  assert.ok(locked.body.wait > 0);
  // Les autres comptes, depuis la même adresse IP, peuvent toujours se connecter.
  assert.equal((await client()("POST", "/api/login", { email: "a@x.fr", password: "motdepasse-123" })).status, 200);
});

/** Kosmy Mobile : ni cookie ni en-tête Origin, un jeton dans Authorization. */
function device(tok) {
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
}
let phoneToken;

test("appareils : connexion par jeton, synchronisation des espaces, déconnexion", async () => {
  const anon = device();
  // Sans origine, la connexion du navigateur est refusée ; celle d'un appareil est acceptée.
  assert.equal((await anon("POST", "/api/login", { email: "a@x.fr", password: "motdepasse-123" })).status, 403);
  assert.equal((await anon("POST", "/api/device/login", { email: "a@x.fr", password: "faux" })).body.error, "login_failed");
  const login = await anon("POST", "/api/device/login", { email: "a@x.fr", password: "motdepasse-123", device: "Pixel 8" });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("set-cookie"), null);
  assert.equal(login.body.user.email, "a@x.fr");
  phoneToken = login.body.token;
  const phone = device(phoneToken);
  assert.equal((await phone("GET", "/api/state")).body.user.email, "a@x.fr");

  // Les espaces du téléphone rejoignent le compte (sans doublon), et inversement.
  const before = (await phone("GET", "/api/spaces")).body.spaces.length;
  const local = [{ id: "tel1", appId: null, name: "Tel", base: "https://tel.example", path: "/admin", addedAt: 1 }];
  assert.equal((await phone("POST", "/api/spaces/import", local)).body.added, 1);
  assert.equal((await phone("POST", "/api/spaces/import", local)).body.skipped, 1);
  const added = await phone("POST", "/api/spaces", { appId: null, name: "Autre", base: "autre.example", path: "/" });
  assert.equal(added.status, 201);
  const web = (await admin("GET", "/api/spaces")).body.spaces;
  assert.equal(web.length, before + 2);
  assert.ok(web.some((s) => s.id === "tel1"));
  assert.equal((await phone("POST", `/api/spaces/${added.body.space.id}/opened`, {})).status, 200);
  assert.equal((await phone("DELETE", `/api/spaces/${added.body.space.id}`)).status, 200);
  assert.equal((await phone("DELETE", "/api/spaces/tel1")).status, 200);

  // Un jeton ne vaut pas cookie ; un en-tête Authorization fait ignorer le cookie.
  assert.equal((await device("x".repeat(43))("GET", "/api/spaces")).status, 401);
  assert.equal((await admin("GET", "/api/spaces", undefined, { Authorization: `Bearer ${"x".repeat(43)}` })).status, 401);
  assert.equal((await stranger("GET", "/api/spaces", undefined, { Cookie: `kb_session=${phoneToken}` })).status, 401);

  // Le Board liste les appareils et peut en déconnecter un.
  const other = (await anon("POST", "/api/device/login", { email: "a@x.fr", password: "motdepasse-123", device: "Vieux téléphone" })).body.token;
  const list = (await admin("GET", "/api/devices")).body.devices;
  assert.deepEqual(list.map((d) => d.name).sort(), ["Pixel 8", "Vieux téléphone"]);
  const old = list.find((d) => d.name === "Vieux téléphone");
  assert.equal((await member("DELETE", `/api/devices/${old.id}`)).status, 404);
  assert.equal((await admin("DELETE", `/api/devices/${old.id}`)).status, 200);
  assert.equal((await device(other)("GET", "/api/spaces")).status, 401);
  assert.equal((await phone("GET", "/api/devices")).body.devices.find((d) => d.current).name, "Pixel 8");

  // Se déconnecter depuis le téléphone révoque son jeton.
  const tmp = (await anon("POST", "/api/device/login", { email: "a@x.fr", password: "motdepasse-123" })).body.token;
  assert.equal((await device(tmp)("POST", "/api/logout", {})).status, 200);
  assert.equal((await device(tmp)("GET", "/api/spaces")).status, 401);
});

test("changer de mot de passe ferme les autres sessions", async () => {
  const other = client();
  assert.equal((await other("POST", "/api/login", { email: "a@x.fr", password: "motdepasse-123" })).status, 200);
  assert.equal((await admin("POST", "/api/password", { current: "faux", next: "nouveau-mdp-789" })).body.error, "current_password");
  assert.equal((await admin("POST", "/api/password", { current: "motdepasse-123", next: "nouveau-mdp-789" })).status, 200);
  assert.equal((await other("GET", "/api/spaces")).status, 401);
  assert.equal((await device(phoneToken)("GET", "/api/spaces")).status, 401);
  assert.equal((await admin("GET", "/api/spaces")).status, 200);
  assert.equal((await admin("POST", "/api/logout", {})).status, 200);
  assert.equal((await admin("GET", "/api/spaces")).status, 401);
});

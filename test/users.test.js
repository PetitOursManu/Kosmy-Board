/*
 * Utilisateurs gérés par le Board (docs/users-api.md), de bout en bout avec l'appli de démonstration :
 * comptes créés par l'administrateur, accès par instance avec rôle et restrictions, liste restreinte,
 * revendication à la connexion, retrait d'accès et suppression.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { browser, startServer } from "./helpers.js";

let srv, admin, demo, dir, file;
let adminId, spaceId, client;
const DEMO_PORT = 22000 + Math.floor(Math.random() * 2000);
const DEMO = `http://localhost:${DEMO_PORT}`;
const CALLBACK = `${DEMO}/auth/kosmy-board/callback`;

const accounts = () => JSON.parse(readFileSync(file, "utf8")).accounts;

before(async () => {
  srv = await startServer();
  admin = browser(srv.base);
  assert.equal((await admin.request("POST", "/api/setup", { code: srv.setupCode, name: "Admin", email: "a@x.fr", password: "motdepasse-123" })).status, 201);
  adminId = (await admin.request("GET", "/api/state")).body.user.id;
  spaceId = (await admin.request("POST", "/api/spaces", { name: "Démo", base: DEMO, path: "/admin" })).body.space.id;
  const on = await admin.request("POST", `/api/spaces/${spaceId}/sso`, { redirectUris: [CALLBACK] });
  client = { id: on.body.clientId, secret: on.body.secret };

  dir = mkdtempSync(path.join(tmpdir(), "kosmy-demo-users-"));
  file = path.join(dir, "settings.json");
  // L'administrateur du Board est administrateur de la démo (relié comme après une première connexion).
  writeFileSync(file, JSON.stringify({
    issuer: `${srv.base}/oidc`, clientId: client.id, clientSecret: client.secret,
    accounts: {
      [adminId]: { name: "Admin", email: "a@x.fr", role: "admin", linkedAt: Date.now() },
      local1: { name: "Ancien", email: "ancien@x.fr", role: "member", linkedAt: Date.now(), local: true },
    },
  }));
  demo = spawn(process.execPath, ["examples/demo-app/server.js"], { env: { ...process.env, PORT: String(DEMO_PORT), DEMO_SETTINGS: file } });
  let out = "";
  await new Promise((resolve, reject) => {
    demo.stdout.on("data", (d) => {
      out += d;
      if (out.includes("Appli de démo")) resolve();
    });
    demo.stderr.on("data", (d) => { out += d; });
    demo.on("exit", () => reject(new Error(out)));
  });
});

after(async () => {
  if (demo) {
    const exited = new Promise((r) => demo.once("exit", r));
    demo.kill();
    await exited;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  await srv.stop();
});

/** Crée un compte depuis le Board, puis la personne choisit son mot de passe par le lien d'activation. */
let checked = false;
async function newPerson(name, email, role = "member") {
  const r = await admin.request("POST", "/api/users", { name, email, role });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.pending, true);
  const tok = r.body.link.url.split("/").pop();
  const b = browser(srv.base);
  assert.deepEqual(await b.request("POST", "/api/password-links/check", { token: tok }).then((x) => x.body), { valid: true, name, email, activation: true });
  // Une fois seulement : les échecs répétés depuis une même adresse finissent bloqués (429).
  const first = !checked;
  checked = true;
  if (first) {
    // Sans mot de passe, pas de connexion possible.
    assert.equal((await b.request("POST", "/api/login", { email, password: "nimportequoi-123" })).status, 401);
    assert.equal((await b.request("POST", "/api/password-links/accept", { token: tok, password: "court" })).body.error, "password_short");
  }
  assert.equal((await b.request("POST", "/api/password-links/accept", { token: tok, password: "motdepasse-789" })).status, 200);
  if (first) assert.equal((await b.request("POST", "/api/password-links/accept", { token: tok, password: "motdepasse-789" })).status, 410);
  const me = (await b.request("GET", "/api/state")).body.user;
  assert.equal(me.email, email);
  return { b, id: me.id };
}

/** Connexion à la démo par le Board : renvoie le contenu de l'ID token (non vérifié ici : oidc.test.js le fait). */
async function idToken(b) {
  const verifier = randomBytes(32).toString("base64url");
  const p = new URLSearchParams({
    client_id: client.id, response_type: "code", scope: "openid profile email", redirect_uri: CALLBACK, state: "s", nonce: "n",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  const end = await b.follow(`/oidc/auth?${p}`);
  if (!end.external) return { denied: end.status };
  const code = new URL(end.location).searchParams.get("code");
  const tok = await fetch(`${srv.base}/oidc/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier }),
  }).then((r) => r.json());
  return JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString());
}

test("un membre ne voit que ses instances, et ne gère ni instances ni utilisateurs", async () => {
  const { b } = await newPerson("Lou", "lou@x.fr");
  const list = await b.request("GET", "/api/spaces");
  assert.deepEqual(list.body.spaces, []);
  assert.equal(list.body.canManage, false);
  assert.equal((await admin.request("GET", "/api/spaces")).body.canManage, true);
  assert.equal((await b.request("POST", "/api/spaces", { name: "X", base: "https://x.example.com", path: "/" })).body.error, "admin");
  assert.equal((await b.request("DELETE", `/api/spaces/${spaceId}`)).status, 403);
  assert.equal((await b.request("GET", "/api/users")).status, 403);
  assert.equal((await b.request("GET", `/api/spaces/${spaceId}/roles`)).status, 403);
  assert.equal((await b.request("PUT", `/api/spaces/${spaceId}/access/${adminId}`, {})).status, 403);
  // Kosmy Mobile envoie ses espaces à la première connexion : ignorés pour un membre.
  assert.deepEqual((await b.request("POST", "/api/spaces/import", [{ name: "Y", base: "https://y.example.com", path: "/" }])).body, { added: 0, skipped: 1, invalid: 0 });
  // Une seule instance par adresse.
  assert.equal((await admin.request("POST", "/api/spaces", { name: "Doublon", base: DEMO, path: "/" })).body.error, "space_exists");
});

test("l'appli décrit ses rôles et ses restrictions", async () => {
  const r = await admin.request("GET", `/api/spaces/${spaceId}/roles?lang=fr`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.protocol, "kosmy.board-users.v1");
  assert.deepEqual(r.body.roles.map((x) => [x.value, x.admin]), [["admin", true], ["member", false]]);
  assert.equal(r.body.defaultRole, "member");
  assert.deepEqual(r.body.fields.map((f) => [f.name, f.type, f.roles]), [["quota", "number", ["member"]], ["canExport", "checkbox", ["member"]]]);
  assert.deepEqual(r.body.users.map((u) => u.sub), [adminId]);
});

test("donner l'accès crée le compte dans l'appli, avec le rôle et les restrictions", async () => {
  const { b, id } = await newPerson("Léa", "lea@x.fr");
  assert.deepEqual((await idToken(b)).denied, 403); // pas encore d'accès : la connexion par le Board est refusée

  // Valeur hors limites : refusée par le Board avant l'appli.
  const bad = await admin.request("PUT", `/api/spaces/${spaceId}/access/${id}`, { role: "member", values: { quota: 1000 } });
  assert.equal(bad.body.error, "access_values");
  assert.equal((await admin.request("PUT", `/api/spaces/${spaceId}/access/${id}`, { role: "chef" })).body.error, "access_role");

  const r = await admin.request("PUT", `/api/spaces/${spaceId}/access/${id}`, { role: "member", values: { quota: 3 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sync.ok, true);
  assert.equal(r.body.sync.status, "created");
  assert.deepEqual(r.body.access.values, { quota: 3, canExport: false });
  assert.equal(r.body.access.label, "Membre");
  const acc = accounts()[id];
  assert.equal(acc.role, "member");
  assert.equal(acc.email, "lea@x.fr");
  assert.deepEqual(acc.values, { quota: 3, canExport: false });
  assert.equal(acc.active, true);

  // Sa liste : l'instance, avec son rôle.
  const mine = (await b.request("GET", "/api/spaces")).body.spaces;
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].access, { role: "member", label: "Membre", admin: false });
  assert.ok(mine[0].sso);

  // À la connexion, l'appli reçoit le rôle et les restrictions.
  const claims = await idToken(b);
  assert.deepEqual(claims.kosmy_board_access, { role: "member", values: { quota: 3, canExport: false } });
  // L'admin du Board, sans accès géré, n'a pas cette revendication.
  assert.equal((await idToken(admin)).kosmy_board_access, undefined);

  // Changer une restriction : les autres gardent leur valeur.
  const up = await admin.request("PUT", `/api/spaces/${spaceId}/access/${id}`, { role: "member", values: { canExport: true } });
  assert.equal(up.body.sync.status, "updated");
  assert.deepEqual(accounts()[id].values, { quota: 3, canExport: true });

  // Le détail de la personne, côté admin.
  const d = await admin.request("GET", `/api/users/${id}`);
  const entry = d.body.spaces.find((x) => x.space.id === spaceId);
  assert.equal(entry.access.managed, true);
  assert.equal(entry.access.sync.status, "ok");
  assert.equal((await admin.request("GET", `/api/spaces/${spaceId}/access`)).body.access.length, 1);

  // Le nom change dans le Board : l'appli suit.
  await admin.request("PATCH", `/api/users/${id}`, { name: "Léa M." });
  for (let i = 0; i < 50 && accounts()[id].name !== "Léa M."; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(accounts()[id].name, "Léa M.");

  // Retirer l'accès : le compte est désactivé dans l'appli, l'instance disparaît de sa liste, la connexion est refusée.
  const rm = await admin.request("DELETE", `/api/spaces/${spaceId}/access/${id}`);
  assert.equal(rm.status, 200);
  assert.equal(rm.body.removed, true);
  assert.equal(accounts()[id].active, false);
  assert.deepEqual((await b.request("GET", "/api/spaces")).body.spaces, []);
  assert.equal((await idToken(b)).denied, 403);

  // Le redonner le réactive.
  assert.equal((await admin.request("PUT", `/api/spaces/${spaceId}/access/${id}`, { role: "admin" })).body.sync.ok, true);
  assert.equal(accounts()[id].active, true);
  assert.equal(accounts()[id].role, "admin");
  assert.equal((await b.request("GET", "/api/spaces")).body.spaces[0].access.admin, true);
});

test("un compte existant de l'appli est relié par son e-mail", async () => {
  const { id } = await newPerson("Ancien", "ancien@x.fr");
  const r = await admin.request("PUT", `/api/spaces/${spaceId}/access/${id}`, { role: "member" });
  assert.equal(r.body.sync.status, "linked");
  assert.equal(accounts().local1, undefined);
  assert.equal(accounts()[id].email, "ancien@x.fr");
});

test("l'appli refuse : rien n'est enregistré", async () => {
  // L'admin se retirerait ses propres droits dans la démo.
  const r = await admin.request("PUT", `/api/spaces/${spaceId}/access/${adminId}`, { role: "member" });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "admin_app_error");
  assert.match(r.body.message, /propres droits/);
  const d = await admin.request("GET", `/api/users/${adminId}`);
  assert.equal(d.body.spaces.find((x) => x.space.id === spaceId).access, null);
});

test("appli sans ce protocole, ou sans connexion unique : accès sans compte géré", async () => {
  const { b, id } = await newPerson("Sam", "sam@x.fr");
  const plain = (await admin.request("POST", "/api/spaces", { name: "Wiki", base: "http://localhost:6", path: "/" })).body.space.id;
  assert.equal((await admin.request("PUT", `/api/spaces/${plain}/access/${id}`, { role: "member" })).body.error, "access_no_sso");
  const self = (await admin.request("POST", "/api/spaces", { name: "Board", base: srv.base, path: "/" })).body.space.id;
  await admin.request("POST", `/api/spaces/${self}/sso`, { redirectUris: [`${srv.base}/cb`] });
  assert.equal((await admin.request("GET", `/api/spaces/${self}/roles`)).body.error, "users_unsupported");
  const r = await admin.request("PUT", `/api/spaces/${plain}/access/${id}`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.access.managed, false);
  assert.deepEqual((await b.request("GET", "/api/spaces")).body.spaces.map((s) => s.name), ["Wiki"]);
  assert.equal((await admin.request("DELETE", `/api/spaces/${plain}/access/${id}`)).body.removed, true);
});

test("nouveau mot de passe par lien, rôle dans le Board, suppression", async () => {
  const { b, id } = await newPerson("Noé", "noe@x.fr");
  await admin.request("PUT", `/api/spaces/${spaceId}/access/${id}`, { role: "member" });
  const link = await admin.request("POST", `/api/users/${id}/password-link`);
  assert.equal(link.status, 201);
  const tok = link.body.url.split("/").pop();
  assert.equal((await b.request("POST", "/api/password-links/check", { token: tok })).body.activation, false);
  const c = browser(srv.base);
  assert.equal((await c.request("POST", "/api/password-links/accept", { token: tok, password: "nouveau-mdp-123" })).status, 200);
  assert.equal((await b.request("GET", "/api/spaces")).status, 401); // ses autres sessions sont fermées

  // On ne change pas son propre rôle ; une adresse déjà prise est refusée.
  assert.equal((await admin.request("PATCH", `/api/users/${adminId}`, { role: "member" })).body.error, "self");
  assert.equal((await admin.request("PATCH", `/api/users/${id}`, { email: "a@x.fr" })).body.error, "email_taken");
  const promoted = await admin.request("PATCH", `/api/users/${id}`, { role: "admin" });
  assert.equal(promoted.body.user.role, "admin");
  assert.equal((await c.request("GET", "/api/spaces")).body.canManage, true);

  // Supprimer : le compte de l'appli est désactivé d'abord.
  const del = await admin.request("DELETE", `/api/users/${id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.warnings, []);
  assert.equal(accounts()[id].active, false);
  assert.equal((await c.request("GET", "/api/spaces")).status, 401);
  assert.equal((await admin.request("DELETE", `/api/users/${adminId}`)).body.error, "self");
});

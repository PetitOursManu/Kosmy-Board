/* Admin dans le Board, de bout en bout : le Board appelle l'appli de démonstration avec son jeton signé. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { browser, startServer } from "./helpers.js";

let srv, admin, member, demo, dir;
let adminId, memberId, spaceId, memberSpaceId;
const DEMO_PORT = 20000 + Math.floor(Math.random() * 2000);
const DEMO = `http://localhost:${DEMO_PORT}`;

async function startDemo(settings) {
  dir = mkdtempSync(path.join(tmpdir(), "kosmy-demo-test-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(settings));
  const proc = spawn(process.execPath, ["examples/demo-app/server.js"], { env: { ...process.env, PORT: String(DEMO_PORT), DEMO_SETTINGS: file } });
  let out = "";
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      out += d;
      if (out.includes("Appli de démo")) resolve();
    });
    proc.stderr.on("data", (d) => { out += d; });
    proc.on("exit", () => reject(new Error(out)));
  });
  return proc;
}

before(async () => {
  srv = await startServer();
  admin = browser(srv.base);
  member = browser(srv.base);
  assert.equal((await admin.request("POST", "/api/setup", { code: srv.setupCode, name: "Admin", email: "a@x.fr", password: "motdepasse-123" })).status, 201);
  adminId = (await admin.request("GET", "/api/state")).body.user.id;
  const inv = await admin.request("POST", "/api/invites", { role: "member" });
  assert.equal((await member.request("POST", "/api/invites/accept", { token: inv.body.url.split("/").pop(), name: "M", email: "m@x.fr", password: "motdepasse-456" })).status, 201);
  memberId = (await member.request("GET", "/api/state")).body.user.id;

  spaceId = (await admin.request("POST", "/api/spaces", { name: "Démo", base: DEMO, path: "/admin" })).body.space.id;
  const on = await admin.request("POST", `/api/spaces/${spaceId}/sso`, { redirectUris: [`${DEMO}/auth/kosmy-board/callback`] });
  assert.equal(on.status, 201);
  memberSpaceId = (await member.request("POST", "/api/spaces", { name: "Démo", base: DEMO, path: "/admin" })).body.space.id;
  assert.equal((await member.request("POST", `/api/spaces/${memberSpaceId}/sso`, {})).status, 200); // rejoint le client existant

  // L'appli est réglée et les deux comptes y sont déjà reliés (comme après une première connexion par le Board).
  demo = await startDemo({
    issuer: `${srv.base}/oidc`, clientId: on.body.clientId, clientSecret: on.body.secret,
    accounts: {
      [adminId]: { name: "Admin", email: "a@x.fr", role: "admin", linkedAt: Date.now() },
      [memberId]: { name: "M", email: "m@x.fr", role: "member", linkedAt: Date.now() },
    },
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

test("sommaire et sections", async () => {
  const m = await admin.request("GET", `/api/spaces/${spaceId}/admin`);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.protocol, "kosmy.board-admin.v1");
  assert.deepEqual(m.body.sections.map((s) => s.id), ["overview", "users", "settings", "maintenance"]);
  assert.equal(m.body.user.role, "Administrateur");

  const users = await admin.request("GET", `/api/spaces/${spaceId}/admin/users`);
  assert.equal(users.status, 200);
  const table = users.body.blocks[0];
  assert.equal(table.type, "table");
  assert.equal(table.rows.length, 2);
  // Pas d'action sur son propre compte, et les actions inconnues des lignes sont écartées.
  assert.equal(table.rows.find((r) => r.id === adminId).actions, undefined);
  assert.deepEqual(table.rows.find((r) => r.id === memberId).actions, ["make-admin", "unlink"]);

  const settings = await admin.request("GET", `/api/spaces/${spaceId}/admin/settings`);
  const form = settings.body.blocks[0];
  assert.equal(form.type, "form");
  assert.equal(form.fields.find((f) => f.name === "signup").value, false);
});

test("actions : formulaire, ligne, valeur à montrer une fois", async () => {
  const bad = await admin.request("POST", `/api/spaces/${spaceId}/admin/settings`, {
    action: "save", values: { name: "", welcome: "", theme: "cyan", maxUsers: 5, signup: false },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, "admin_app_error");
  assert.match(bad.body.message, /nom du site/);

  const ok = await admin.request("POST", `/api/spaces/${spaceId}/admin/settings`, {
    action: "save", values: { name: "Ma démo", welcome: "Salut", theme: "lime", maxUsers: 5, signup: true },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.message, "Réglages enregistrés.");
  assert.equal(ok.body.section.blocks[0].fields.find((f) => f.name === "name").value, "Ma démo");

  const promote = await admin.request("POST", `/api/spaces/${spaceId}/admin/users`, { action: "make-admin", row: memberId });
  assert.equal(promote.status, 200);
  assert.equal(promote.body.section.blocks[0].rows.find((r) => r.id === memberId).cells.role.text, "Administrateur");
  await admin.request("POST", `/api/spaces/${spaceId}/admin/users`, { action: "make-member", row: memberId });

  const invite = await admin.request("POST", `/api/spaces/${spaceId}/admin/users`, { action: "invite", values: { email: "z@x.fr", role: "member" } });
  assert.equal(invite.body.reveal.label, "Lien d'invitation");
  assert.ok(invite.body.reveal.value.startsWith(`${DEMO}/login?invitation=`));

  // Entrée refusée par le Board avant même d'aller à l'appli.
  assert.equal((await admin.request("POST", `/api/spaces/${spaceId}/admin/users`, { action: "<script>" })).body.error, "admin_action");
  assert.equal((await admin.request("POST", `/api/spaces/${spaceId}/admin/users`, { action: "invite", values: { a: { b: 1 } } })).body.error, "admin_action");
});

test("l'appli décide des droits", async () => {
  const r = await member.request("GET", `/api/spaces/${memberSpaceId}/admin`);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "admin_forbidden");
  assert.match(r.body.message, /droits/);
});

test("sans connexion unique, ou appli qui ne connaît pas le protocole", async () => {
  const plain = (await admin.request("POST", "/api/spaces", { name: "Autre", base: "http://localhost:9", path: "/" })).body.space.id;
  assert.equal((await admin.request("GET", `/api/spaces/${plain}/admin`)).body.error, "admin_no_sso");

  // Le Board lui-même ne propose pas ce protocole : il répond 404 en JSON.
  const self = (await admin.request("POST", "/api/spaces", { name: "Board", base: srv.base, path: "/" })).body.space.id;
  assert.equal((await admin.request("POST", `/api/spaces/${self}/sso`, { redirectUris: [`${srv.base}/cb`] })).status, 201);
  assert.equal((await admin.request("GET", `/api/spaces/${self}/admin`)).body.error, "admin_unsupported");

  // Instance injoignable.
  const off = (await admin.request("POST", "/api/spaces", { name: "Éteinte", base: "http://localhost:9", path: "/" })).body.space.id;
  await admin.request("POST", `/api/spaces/${off}/sso`, { redirectUris: ["http://localhost:9/cb"] });
  assert.equal((await admin.request("GET", `/api/spaces/${off}/admin`)).body.error, "admin_unreachable");
});

test("l'appli refuse un appel sans jeton du Board, ou avec un jeton non signé", async () => {
  const none = await fetch(`${DEMO}/api/kosmy-board/admin`);
  assert.equal(none.status, 401);
  assert.equal((await none.json()).error, "invalid_token");
  const forged = await fetch(`${DEMO}/api/kosmy-board/admin`, { headers: { Authorization: "Bearer eyJhbGciOiJub25lIn0.e30." } });
  assert.equal(forged.status, 401);
});

test("section inconnue", async () => {
  assert.equal((await admin.request("GET", `/api/spaces/${spaceId}/admin/nope`)).body.error, "admin_not_found");
  assert.equal((await admin.request("GET", `/api/spaces/${spaceId}/admin/..%2F`)).status, 404);
});

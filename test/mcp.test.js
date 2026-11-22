/* Serveur MCP du Board : jetons personnels, outils, garde-fous, et parcours OAuth complet (inscription dynamique, consentement). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { browser, startServer } from "./helpers.js";

let srv, admin, demo, dir, spaceId, mcpToken;
const DEMO_PORT = 24000 + Math.floor(Math.random() * 2000);
const DEMO = `http://localhost:${DEMO_PORT}`;

async function startDemo(settings) {
  dir = mkdtempSync(path.join(tmpdir(), "kosmy-demo-mcp-"));
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

let rpcId = 0;
/** Un appel JSON-RPC au serveur MCP. */
async function mcp(method, params, { auth = mcpToken, headers = {} } = {}) {
  const res = await fetch(`${srv.base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const call = async (name, args, opts) => (await mcp("tools/call", { name, arguments: args }, opts)).body.result;

before(async () => {
  srv = await startServer();
  admin = browser(srv.base);
  assert.equal((await admin.request("POST", "/api/setup", { code: srv.setupCode, name: "Admin", email: "a@x.fr", password: "motdepasse-123" })).status, 201);
  const adminId = (await admin.request("GET", "/api/state")).body.user.id;
  spaceId = (await admin.request("POST", "/api/spaces", { name: "Démo", base: DEMO, path: "/admin" })).body.space.id;
  const on = await admin.request("POST", `/api/spaces/${spaceId}/sso`, { redirectUris: [`${DEMO}/auth/kosmy-board/callback`] });
  demo = await startDemo({
    issuer: `${srv.base}/oidc`, clientId: on.body.clientId, clientSecret: on.body.secret,
    accounts: { [adminId]: { name: "Admin", email: "a@x.fr", role: "admin", linkedAt: Date.now() } },
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

test("sans jeton : 401 avec l'adresse des métadonnées ; autre origine refusée", async () => {
  const r = await mcp("initialize", {}, { auth: null });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("www-authenticate"), `Bearer resource_metadata="${srv.base}/.well-known/oauth-protected-resource/mcp"`);
  assert.equal((await mcp("initialize", {}, { auth: "kbm_faux-jeton-1234567890" })).status, 401);

  const created = await admin.request("POST", "/api/mcp/tokens", { name: "Claude Code" });
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^kbm_/);
  mcpToken = created.body.token;
  assert.equal((await mcp("ping", {}, { headers: { Origin: "https://evil.example" } })).status, 403);
  // Le jeton n'est plus jamais montré.
  const list = await admin.request("GET", "/api/mcp");
  assert.equal(list.body.tokens[0].name, "Claude Code");
  assert.equal(list.body.tokens[0].token, undefined);
  assert.equal(list.body.url, `${srv.base}/mcp`);
});

test("initialize, tools/list, notifications", async () => {
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.serverInfo.name, "kosmy-board");
  assert.ok(init.body.result.capabilities.tools);

  const notif = await fetch(`${srv.base}/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcpToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notif.status, 202);

  const tools = (await mcp("tools/list")).body.result.tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.list_spaces.annotations.readOnlyHint, true);
  assert.equal(byName.run_dangerous_admin_action.annotations.destructiveHint, true);
  assert.equal(byName.delete_space.annotations.destructiveHint, true);
  assert.equal(byName.run_admin_action.annotations.destructiveHint, false);
  assert.equal(byName.run_admin_action.inputSchema.type, "object");
  assert.equal((await mcp("nope")).body.error.code, -32601);
});

test("outils : lecture, action dangereuse par l'outil dédié, valeur à montrer une fois par lien", async () => {
  const spaces = await call("list_spaces", {});
  assert.equal(spaces.isError, false);
  assert.equal(spaces.structuredContent.spaces[0].name, "Démo");

  const refused = await call("run_admin_action", { space: "Démo", section: "maintenance", action: "logout-all" });
  assert.equal(refused.structuredContent.status, "confirmation_required");
  assert.match(refused.structuredContent.message, /run_dangerous_admin_action/);

  const done = await call("run_dangerous_admin_action", { space: "Démo", section: "maintenance", action: "logout-all" });
  assert.equal(done.isError, false, JSON.stringify(done));
  assert.equal(done.structuredContent.ok, true);
  const audit = (await admin.request("GET", "/api/assistant/audit")).body.entries;
  assert.equal(audit[0].channel, "mcp");
  assert.equal(audit[0].detail.action, "logout-all");

  const invite = await call("run_admin_action", { space: spaceId, section: "users", action: "invite", values: { email: "z@x.fr" } });
  assert.equal(JSON.stringify(invite).includes("invitation="), false, "le lien ne passe pas par le client MCP");
  const link = invite.structuredContent.oneTimeValues[0].openInKosmyBoard;
  assert.match(link, new RegExp(`^${srv.base}/#/valeur/`));
  const id = link.split("/").pop();
  const stranger = browser(srv.base);
  assert.equal((await stranger.request("POST", `/api/assistant/reveal/${id}`, {})).status, 401);
  const shown = await admin.request("POST", `/api/assistant/reveal/${id}`, {});
  assert.ok(shown.body.value.startsWith(`${DEMO}/login?invitation=`));
  assert.equal((await admin.request("POST", `/api/assistant/reveal/${id}`, {})).status, 410, "une seule fois");

  const bad = await call("get_admin_section", { space: "Démo", section: "nope" });
  assert.equal(bad.isError, true);
});

test("jeton révoqué", async () => {
  const t = await admin.request("POST", "/api/mcp/tokens", { name: "Temporaire" });
  assert.equal((await mcp("ping", {}, { auth: t.body.token })).status, 200);
  assert.equal((await admin.request("DELETE", `/api/mcp/tokens/${t.body.id}`)).status, 200);
  assert.equal((await mcp("ping", {}, { auth: t.body.token })).status, 401);
});

test("OAuth : métadonnées, inscription dynamique, consentement, jetons, retrait", async () => {
  const prm = await fetch(`${srv.base}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
  assert.equal(prm.resource, `${srv.base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [`${srv.base}/oidc`]);
  const as = await fetch(`${srv.base}/.well-known/oauth-authorization-server/oidc`).then((r) => r.json());
  assert.equal(as.issuer, `${srv.base}/oidc`);
  assert.ok(as.registration_endpoint, JSON.stringify(as));
  assert.ok(as.code_challenge_methods_supported.includes("S256"));
  assert.equal(as.authorization_endpoint, `${srv.base}/oidc/auth`);

  const REDIRECT = "http://localhost:33418/callback";
  const reg = await fetch(as.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  }).then((r) => r.json());
  assert.match(reg.client_id, /^mcp-/, JSON.stringify(reg));

  // Le flux implicite n'existe pas sur ce Board.
  const implicit = await fetch(as.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], response_types: ["id_token"], grant_types: ["implicit"] }),
  });
  assert.equal(implicit.status, 400);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = `/oidc/auth?${new URLSearchParams({
    client_id: reg.client_id, response_type: "code", redirect_uri: REDIRECT, state: "s1", scope: "kosmy:mcp",
    code_challenge: challenge, code_challenge_method: "S256", resource: `${srv.base}/mcp`,
  })}`;
  // Sans PKCE : refusé.
  const noPkce = await admin.follow(`/oidc/auth?${new URLSearchParams({ client_id: reg.client_id, response_type: "code", redirect_uri: REDIRECT, state: "s0" })}`);
  assert.ok(noPkce.external && new URL(noPkce.location).searchParams.get("error"), "PKCE exigé");

  // Pas connecté au Board : on passe par la page de connexion.
  const stranger = browser(srv.base);
  assert.match((await stranger.follow(auth)).location, /^\/#\/\?retour=/);

  const consent = await admin.follow(auth);
  assert.equal(consent.status, 200);
  assert.match(consent.text, /Claude Code/);
  assert.match(consent.text, /localhost:33418/);
  const action = consent.text.match(/action="([^"]+\/confirm)"/)[1];
  assert.equal((await admin.request("POST", action, "", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status, 405);
  const ok = await admin.request("POST", action, "", { Origin: "null", "Sec-Fetch-Site": "same-origin" });
  const end = await admin.follow(ok.location);
  assert.ok(end.external, `arrêté sur ${end.status} ${end.location} ${end.text?.slice(0, 300)}`);
  const back = new URL(end.location);
  assert.equal(back.searchParams.get("state"), "s1");
  const code = back.searchParams.get("code");
  assert.ok(code, end.location);

  const tok = await fetch(`${srv.base}/oidc/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: reg.client_id, resource: `${srv.base}/mcp` }),
  }).then((r) => r.json());
  assert.ok(tok.access_token, JSON.stringify(tok));
  assert.equal(tok.access_token.split(".").length, 3, "jeton d'accès JWT");
  assert.ok(tok.refresh_token);

  const spaces = await call("list_spaces", {}, { auth: tok.access_token });
  assert.equal(spaces.structuredContent.spaces[0].name, "Démo");

  // Rafraîchir : un nouveau jeton d'accès, toujours pour /mcp.
  const refreshed = await fetch(`${srv.base}/oidc/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id, resource: `${srv.base}/mcp` }),
  }).then((r) => r.json());
  assert.ok(refreshed.access_token, JSON.stringify(refreshed));
  assert.equal((await mcp("ping", {}, { auth: refreshed.access_token })).status, 200);

  // Un ID token, ou un jeton d'une instance reliée, ne vaut pas pour /mcp.
  const grants = (await admin.request("GET", "/api/mcp")).body.grants;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].client, "Claude Code");
  assert.equal((await admin.request("DELETE", `/api/mcp/grants/${grants[0].id}`)).status, 200);
  assert.equal((await mcp("ping", {}, { auth: refreshed.access_token })).status, 401, "accès retiré");
});

test("OAuth : client confidentiel, sans « scope » ni « resource » (ressource par défaut)", async () => {
  const as = await fetch(`${srv.base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const REDIRECT = "https://claude.example/api/mcp/auth_callback";
  const reg = await fetch(as.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post", grant_types: ["authorization_code", "refresh_token"] }),
  }).then((r) => r.json());
  assert.ok(reg.client_secret, JSON.stringify(reg));
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const consent = await admin.follow(`/oidc/auth?${new URLSearchParams({ client_id: reg.client_id, response_type: "code", redirect_uri: REDIRECT, state: "s2", code_challenge: challenge, code_challenge_method: "S256" })}`);
  const action = consent.text.match(/action="([^"]+\/confirm)"/)[1];
  const end = await admin.follow((await admin.request("POST", action, "", { Origin: "null", "Sec-Fetch-Site": "same-origin" })).location);
  const code = new URL(end.location).searchParams.get("code");
  const tok = await fetch(`${srv.base}/oidc/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: reg.client_id, client_secret: reg.client_secret }),
  }).then((r) => r.json());
  assert.ok(tok.access_token, JSON.stringify(tok));
  assert.equal((await mcp("ping", {}, { auth: tok.access_token })).status, 200);
});

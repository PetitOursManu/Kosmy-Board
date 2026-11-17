/* Connexion unique de bout en bout : une appli fictive se connecte avec Kosmy Board, comme une vraie. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { totpAt, currentStep } from "../server/totp.js";
import { browser, startServer } from "./helpers.js";

let srv, admin, member;
const APP = "http://localhost:9911";
const REDIRECT = `${APP}/auth/kosmy-board/callback`;
let client, spaceId, adminId;

before(async () => {
  srv = await startServer();
  admin = browser(srv.base);
  member = browser(srv.base);
  assert.equal((await admin.request("POST", "/api/setup", { code: srv.setupCode, name: "Admin", email: "a@x.fr", password: "motdepasse-123" })).status, 201);
  adminId = (await admin.request("GET", "/api/state")).body.user.id;
  const inv = await admin.request("POST", "/api/invites", { role: "member" });
  const token = inv.body.url.split("/").pop();
  assert.equal((await member.request("POST", "/api/invites/accept", { token, name: "M", email: "m@x.fr", password: "motdepasse-456" })).status, 201);
});
after(() => srv.stop());

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
function authUrl(clientId, { state = "st", nonce = "no", challenge } = {}) {
  const p = new URLSearchParams({
    client_id: clientId, response_type: "code", scope: "openid profile email", redirect_uri: REDIRECT, state, nonce,
    ...(challenge ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
  });
  return `/oidc/auth?${p}`;
}

test("activer la connexion unique sur un espace", async () => {
  const sp = await admin.request("POST", "/api/spaces", { appId: "kanby", name: "Kanby", base: APP, path: "/admin" });
  spaceId = sp.body.space.id;
  const info = await admin.request("GET", `/api/spaces/${spaceId}/sso`);
  assert.equal(info.body.enabled, false);
  assert.equal(info.body.defaults.redirectUri, REDIRECT);
  assert.equal((await admin.request("POST", `/api/spaces/${spaceId}/sso`, { redirectUris: ["http://kanby.example.com/cb"] })).body.error, "redirect_uri_https");
  const on = await admin.request("POST", `/api/spaces/${spaceId}/sso`, { redirectUris: [REDIRECT], initiateLoginUri: `${APP}/auth/kosmy-board/login` });
  assert.equal(on.status, 201);
  assert.ok(on.body.secret.length > 30);
  client = { id: on.body.clientId, secret: on.body.secret };
  // Le secret n'est plus jamais renvoyé ensuite.
  assert.equal((await admin.request("GET", `/api/spaces/${spaceId}/sso`)).body.secret, undefined);
  const list = (await admin.request("GET", "/api/spaces")).body.spaces;
  assert.equal(list[0].sso.loginUri, `${APP}/auth/kosmy-board/login`);
  // L'export reste au format Kosmy Mobile, sans la connexion unique.
  assert.equal((await admin.request("GET", "/api/spaces/export")).body.spaces[0].sso, undefined);
});

test("découverte OpenID Connect", async () => {
  const d = await fetch(`${srv.base}/oidc/.well-known/openid-configuration`).then((r) => r.json());
  assert.equal(d.issuer, `${srv.base}/oidc`);
  assert.ok(d.authorization_endpoint && d.token_endpoint && d.jwks_uri && d.userinfo_endpoint);
  assert.ok(d.scopes_supported.includes("email"));
  const root = await fetch(`${srv.base}/.well-known/openid-configuration`, { redirect: "manual" });
  assert.equal(root.status, 307);
});

test("parcours complet : code d'autorisation, PKCE, ID token", async () => {
  const { verifier, challenge } = pkce();
  const end = await admin.follow(authUrl(client.id, { challenge, nonce: "n-123" }));
  assert.ok(end.external, `arrêté sur ${end.status} ${end.location}`);
  const back = new URL(end.location);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "st");
  assert.equal(back.searchParams.get("iss"), `${srv.base}/oidc`);
  const code = back.searchParams.get("code");

  const tok = await fetch(`${srv.base}/oidc/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }),
  }).then((r) => r.json());
  assert.ok(tok.id_token, JSON.stringify(tok));

  const jwks = createRemoteJWKSet(new URL(`${srv.base}/oidc/jwks`));
  const { payload } = await jwtVerify(tok.id_token, jwks, { issuer: `${srv.base}/oidc`, audience: client.id });
  assert.equal(payload.sub, adminId);
  assert.equal(payload.nonce, "n-123");
  assert.equal(payload.email, "a@x.fr");
  assert.equal(payload.email_verified, false);
  assert.equal(payload.name, "Admin");

  const info = await fetch(`${srv.base}/oidc/me`, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
  assert.equal(info.sub, adminId);

  // Le code ne sert qu'une fois.
  const again = await fetch(`${srv.base}/oidc/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  assert.equal(again.status, 400);
});

test("mauvais secret ou mauvaise adresse de retour : refusé", async () => {
  const bad = await fetch(`${srv.base}/oidc/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${client.id}:faux`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "x", redirect_uri: REDIRECT }),
  });
  assert.equal(bad.status, 401);
  const r = await admin.follow(`/oidc/auth?${new URLSearchParams({ client_id: client.id, response_type: "code", scope: "openid", redirect_uri: "https://evil.example/cb" })}`);
  assert.ok(!r.external);
  assert.equal(r.status, 400);
  assert.match(r.text, /Kosmy Board/);
});

test("sans espace relié, l'accès est refusé", async () => {
  const r = await member.follow(authUrl(client.id));
  assert.equal(r.status, 403);
  assert.match(r.text, /Accès|Access/);
  // La CSP des pages de connexion unique laisse le formulaire rediriger vers l'appli.
  assert.doesNotMatch(r.headers.get("content-security-policy"), /form-action/);
  // « Revenir à l'appli » : formulaire classique, que le navigateur envoie avec « Origin: null ».
  const action = r.text.match(/action="([^"]+\/abort)"/)[1];
  const forged = await member.request("POST", action, "", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
  assert.equal(forged.status, 405);
  const abort = await member.request("POST", action, "", { Origin: "null", "Sec-Fetch-Site": "same-origin" });
  assert.equal(abort.status, 303);
  const resumed = await member.follow(abort.location);
  assert.ok(resumed.external);
  const back = new URL(resumed.location);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("error"), "access_denied");
  // Le membre ajoute la même instance : il rejoint le client existant, sans voir le secret.
  const sp = await member.request("POST", "/api/spaces", { appId: "kanby", name: "Kanby", base: APP, path: "/admin" });
  const info = await member.request("GET", `/api/spaces/${sp.body.space.id}/sso`);
  assert.equal(info.body.existing, true);
  const join = await member.request("POST", `/api/spaces/${sp.body.space.id}/sso`, {});
  assert.equal(join.status, 200);
  assert.equal(join.body.secret, undefined);
  assert.equal(join.body.canManage, false);
  assert.equal(join.body.sharedWith, 2);
  assert.equal((await member.request("POST", `/api/spaces/${sp.body.space.id}/sso/secret`)).status, 403);
  const ok = await member.follow(authUrl(client.id));
  assert.ok(ok.external);
  assert.ok(new URL(ok.location).searchParams.get("code"));
});

test("sans session du Board, retour à la page de connexion du Board", async () => {
  const stranger = browser(srv.base);
  const r = await stranger.follow(authUrl(client.id));
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/#\/\?retour=%2Foidc%2Finteraction%2F/);
  // Se déconnecter du Board coupe aussi les nouvelles connexions aux applis.
  assert.equal((await admin.request("POST", "/api/logout", {})).status, 200);
  const again = await admin.follow(authUrl(client.id));
  assert.equal(again.status, 303);
  assert.match(again.location, /retour=/);
});

test("désactiver : le client disparaît quand plus personne ne l'utilise", async () => {
  assert.equal((await admin.request("POST", "/api/login", { email: "a@x.fr", password: "motdepasse-123" })).status, 200);
  assert.equal((await admin.request("DELETE", `/api/spaces/${spaceId}/sso`)).status, 200);
  const d = await fetch(`${srv.base}/oidc/.well-known/openid-configuration`).then((r) => r.json());
  assert.ok(d.issuer);
  // Le membre l'utilise encore : le client existe toujours.
  assert.ok((await member.follow(authUrl(client.id))).external);
  const ms = (await member.request("GET", "/api/spaces")).body.spaces[0];
  assert.equal((await member.request("DELETE", `/api/spaces/${ms.id}`)).status, 200);
  const gone = await member.follow(authUrl(client.id));
  assert.ok(!gone.external);
  assert.equal(gone.status, 400);
});

test("double authentification : activation, connexion, codes de secours", async () => {
  const u = browser(srv.base);
  assert.equal((await u.request("POST", "/api/login", { email: "a@x.fr", password: "motdepasse-123" })).body.ok, true);
  const setup = await u.request("POST", "/api/2fa/setup", {});
  assert.match(setup.body.uri, /^otpauth:\/\/totp\//);
  assert.match(setup.body.qr, /^<svg/);
  assert.equal((await u.request("POST", "/api/2fa/enable", { code: "000000" })).body.error, "code");
  const step = currentStep();
  const en = await u.request("POST", "/api/2fa/enable", { code: totpAt(setup.body.secret, step) });
  assert.equal(en.body.recoveryCodes.length, 10);
  assert.equal((await u.request("GET", "/api/state")).body.user.totp, true);

  // Connexion : mot de passe, puis code.
  const v = browser(srv.base);
  const first = await v.request("POST", "/api/login", { email: "a@x.fr", password: "motdepasse-123" });
  assert.equal(first.body.twoFactor, true);
  assert.equal((await v.request("GET", "/api/spaces")).status, 401);
  // Le code déjà utilisé à l'activation ne repasse pas.
  assert.equal((await v.request("POST", "/api/login/2fa", { ticket: first.body.ticket, code: totpAt(setup.body.secret, step) })).body.error, "code");
  const rc = en.body.recoveryCodes[0];
  assert.equal((await v.request("POST", "/api/login/2fa", { ticket: first.body.ticket, code: rc.toLowerCase() })).body.ok, true);
  assert.equal((await v.request("GET", "/api/spaces")).status, 200);
  // Un code de secours ne sert qu'une fois.
  const w = browser(srv.base);
  const t2 = (await w.request("POST", "/api/login", { email: "a@x.fr", password: "motdepasse-123" })).body.ticket;
  assert.equal((await w.request("POST", "/api/login/2fa", { ticket: t2, code: rc })).body.error, "code");
  assert.equal((await w.request("POST", "/api/login/2fa", { ticket: "faux", code: rc })).status, 401);

  // Désactiver : mot de passe et code.
  assert.equal((await u.request("POST", "/api/2fa/disable", { password: "faux", code: en.body.recoveryCodes[1] })).body.error, "current_password");
  assert.equal((await u.request("POST", "/api/2fa/disable", { password: "motdepasse-123", code: en.body.recoveryCodes[1] })).status, 200);
  assert.equal((await u.request("GET", "/api/state")).body.user.totp, false);
});

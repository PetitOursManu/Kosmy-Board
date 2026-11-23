/*
 * Connexion unique : Kosmy Board est un fournisseur d'identité OpenID Connect (bibliothèque oidc-provider, certifiée).
 *
 * - Chaque instance reliée au Board est un « client » (sso_clients), partagé par toutes les personnes du Board
 *   qui ont un espace pour cette instance.
 * - On ne se connecte à une instance par le Board que si l'on a, dans son Board, un espace relié à ce client.
 * - Il faut aussi être connecté au Board lui-même : se déconnecter du Board coupe les nouvelles connexions aux applis.
 */
import { generateKeyPairSync, randomBytes, createHash } from "node:crypto";

import { importJWK, jwtVerify } from "jose";
import Provider, { errors, interactionPolicy } from "oidc-provider";

import { currentUser } from "./auth.js";
import { config } from "./config.js";
import { db, meta } from "./db.js";
import { sameOrigin } from "./http.js";
import { page, pageLang, tr } from "./pages.js";
import { esc } from "./util.js";

export const ISSUER = `${config.publicUrl}/oidc`;
export const MOUNT = "/oidc";

/* ---------- Clés (créées au premier lancement, gardées dans la base) ---------- */

function signingKeys() {
  const saved = meta.get("oidc_jwks");
  if (saved) return JSON.parse(saved);
  // RS256 : l'algorithme que toutes les bibliothèques OpenID Connect savent vérifier.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" });
  const kid = createHash("sha256").update(jwk.n).digest("base64url").slice(0, 16);
  const keys = [{ ...jwk, kid, use: "sig", alg: "RS256" }];
  meta.set("oidc_jwks", JSON.stringify(keys));
  return keys;
}

/** La clé privée de signature (JWK), aussi utilisée pour les jetons de l'admin dans le Board (server/admin.js). */
export const signingJwk = () => signingKeys()[0];

function cookieKeys() {
  const saved = meta.get("oidc_cookie_keys");
  if (saved) return JSON.parse(saved);
  const keys = [randomBytes(32).toString("base64url")];
  meta.set("oidc_cookie_keys", JSON.stringify(keys));
  return keys;
}

/* ---------- Stockage SQLite pour oidc-provider ---------- */

/** Métadonnées OpenID d'un client, telles que oidc-provider les attend. */
export function clientMetadata(row) {
  return {
    client_id: row.client_id,
    client_secret: row.secret,
    client_name: row.name,
    redirect_uris: JSON.parse(row.redirect_uris),
    post_logout_redirect_uris: [row.base, `${row.base}/`],
    response_types: ["code"],
    grant_types: ["authorization_code"],
    token_endpoint_auth_method: row.auth_method,
  };
}

class SqliteAdapter {
  constructor(model) {
    this.model = model;
  }

  async upsert(id, payload, expiresIn) {
    db.prepare(
      `INSERT INTO oidc_store (model, id, payload, grant_id, user_code, uid, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model, id) DO UPDATE SET payload = excluded.payload, grant_id = excluded.grant_id,
         user_code = excluded.user_code, uid = excluded.uid, expires_at = excluded.expires_at`,
    ).run(this.model, id, JSON.stringify(payload), payload.grantId ?? null, payload.userCode ?? null, payload.uid ?? null,
      expiresIn ? Date.now() + expiresIn * 1000 : null);
  }

  #read(row) {
    if (!row || (row.expires_at && row.expires_at < Date.now())) return undefined;
    const payload = JSON.parse(row.payload);
    if (row.consumed_at) payload.consumed = Math.floor(row.consumed_at / 1000);
    return payload;
  }

  async find(id) {
    if (this.model === "Client") {
      const row = db.prepare("SELECT * FROM sso_clients WHERE client_id = ?").get(id);
      if (row) return clientMetadata(row);
      // Clients MCP inscrits d'eux-mêmes (inscription dynamique) : gardés comme les autres modèles.
      if (!isMcpClientId(id)) return undefined;
    }
    return this.#read(db.prepare("SELECT * FROM oidc_store WHERE model = ? AND id = ?").get(this.model, id));
  }

  async findByUid(uid) {
    return this.#read(db.prepare("SELECT * FROM oidc_store WHERE model = ? AND uid = ?").get(this.model, uid));
  }

  async findByUserCode(userCode) {
    return this.#read(db.prepare("SELECT * FROM oidc_store WHERE model = ? AND user_code = ?").get(this.model, userCode));
  }

  async consume(id) {
    db.prepare("UPDATE oidc_store SET consumed_at = ? WHERE model = ? AND id = ?").run(Date.now(), this.model, id);
  }

  async destroy(id) {
    db.prepare("DELETE FROM oidc_store WHERE model = ? AND id = ?").run(this.model, id);
  }

  async revokeByGrantId(grantId) {
    db.prepare("DELETE FROM oidc_store WHERE grant_id = ?").run(grantId);
  }
}

export function purgeOidc() {
  db.prepare("DELETE FROM oidc_store WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now());
}

/* ---------- Droits ---------- */

/** La personne a-t-elle accès à l'instance de ce client ? Les administrateurs du Board ont accès à toutes. */
export const userHasClient = (userId, clientId) => Boolean(db.prepare(
  `SELECT 1 FROM instances i WHERE i.client_id = $client AND (
     EXISTS (SELECT 1 FROM users u WHERE u.id = $user AND u.role = 'admin')
     OR EXISTS (SELECT 1 FROM access a WHERE a.instance_id = i.id AND a.user_id = $user AND a.revoked = 0))`,
).get({ client: clientId, user: userId }));

/** Rôle et restrictions choisis dans le Board pour cette personne sur cette instance (docs/users-api.md), ou null. */
export function accessClaim(userId, clientId) {
  if (!clientId) return null;
  const r = db.prepare(
    `SELECT a.role, a.settings FROM access a JOIN instances i ON i.id = a.instance_id
      WHERE i.client_id = ? AND a.user_id = ? AND a.revoked = 0 AND a.role IS NOT NULL`,
  ).get(clientId, userId);
  return r ? { role: r.role, values: JSON.parse(r.settings || "{}") } : null;
}

/* ---------- Clients MCP (Claude, autres clients MCP) : OAuth pour le serveur MCP du Board ---------- */

/** La ressource protégée (server/mcp.js) et le préfixe des clients inscrits par inscription dynamique. */
export const MCP_RESOURCE = `${config.publicUrl}/mcp`;
export const MCP_SCOPE = "kosmy:mcp";
export const isMcpClientId = (id) => typeof id === "string" && id.startsWith("mcp-");

function mcpClient(clientId) {
  const row = db.prepare("SELECT payload FROM oidc_store WHERE model = 'Client' AND id = ?").get(clientId);
  return row ? JSON.parse(row.payload) : null;
}

/** Autorisations données à des clients MCP par cette personne. */
export function listMcpGrants(userId) {
  return db.prepare("SELECT id, payload FROM oidc_store WHERE model = 'Grant' AND json_extract(payload, '$.accountId') = ?").all(userId)
    .map((r) => ({ id: r.id, p: JSON.parse(r.payload) }))
    .filter((g) => isMcpClientId(g.p.clientId))
    .map((g) => ({ id: g.id, clientId: g.p.clientId, client: mcpClient(g.p.clientId)?.client_name ?? g.p.clientId, createdAt: (g.p.iat ?? 0) * 1000 }));
}

/** Retire une autorisation : ses jetons (d'accès et de rafraîchissement) disparaissent avec elle. */
export function revokeMcpGrant(userId, grantId) {
  const g = db.prepare("SELECT payload FROM oidc_store WHERE model = 'Grant' AND id = ?").get(grantId);
  const p = g ? JSON.parse(g.payload) : null;
  if (!p || p.accountId !== userId || !isMcpClientId(p.clientId)) return false;
  db.prepare("DELETE FROM oidc_store WHERE grant_id = ? OR (model = 'Grant' AND id = ?)").run(grantId, grantId);
  return true;
}

let publicKey = null;
/**
 * Jeton d'accès OAuth présenté au serveur MCP : un JWT signé par le Board, émis pour la ressource /mcp,
 * à un client MCP dont l'autorisation existe toujours. Renvoie l'identifiant du compte, ou null.
 */
export async function verifyMcpAccessToken(tok, resource = MCP_RESOURCE) {
  if (tok.split(".").length !== 3) return null;
  try {
    const { kty, n, e, kid } = signingJwk();
    publicKey ??= await importJWK({ kty, n, e }, "RS256");
    const { payload, protectedHeader } = await jwtVerify(tok, publicKey, { issuer: ISSUER, audience: resource, algorithms: ["RS256"] });
    if (protectedHeader.kid && protectedHeader.kid !== kid) return null;
    if (protectedHeader.typ && protectedHeader.typ.toLowerCase() !== "at+jwt") return null;
    if (!isMcpClientId(payload.client_id) || typeof payload.sub !== "string") return null;
    // Autorisation retirée dans le Board : ses jetons ne valent plus, même avant leur expiration.
    const grant = db.prepare(
      "SELECT 1 FROM oidc_store WHERE model = 'Grant' AND json_extract(payload, '$.accountId') = ? AND json_extract(payload, '$.clientId') = ? AND (expires_at IS NULL OR expires_at > ?)",
    ).get(payload.sub, payload.client_id, Date.now());
    return grant ? payload.sub : null;
  } catch {
    return null;
  }
}

const clientName = (clientId) =>
  db.prepare("SELECT name FROM sso_clients WHERE client_id = ?").get(clientId)?.name ?? mcpClient(clientId)?.client_name ?? clientId;
const clientBase = (clientId) => db.prepare("SELECT base FROM sso_clients WHERE client_id = ?").get(clientId)?.base ?? null;

/* ---------- Le fournisseur ---------- */

const { base: basePolicy, Check } = interactionPolicy;
const policy = basePolicy();
/* Même si oidc-provider garde sa propre session, chaque connexion à une appli exige la session du Board et le droit d'accès. */
policy.get("login").checks.add(new Check("kosmy_board", "Kosmy Board session and access are required", (ctx) => {
  const user = currentUser(ctx.req);
  if (!user || user.id !== ctx.oidc.session?.accountId) return Check.REQUEST_PROMPT;
  // Un client MCP n'est pas une instance reliée : la personne donne son accord sur la page de consentement.
  if (!isMcpClientId(ctx.oidc.client.clientId) && !userHasClient(user.id, ctx.oidc.client.clientId)) return Check.REQUEST_PROMPT;
  return Check.NO_NEED_TO_PROMPT;
}));

function sendPage(ctx, html, status = 200) {
  ctx.status = status;
  ctx.type = "html";
  ctx.body = html;
}

export const provider = new Provider(ISSUER, {
  adapter: SqliteAdapter,
  jwks: { keys: signingKeys() },
  cookies: {
    keys: cookieKeys(),
    names: { session: "kb_oidc_session", interaction: "kb_oidc_interaction", resume: "kb_oidc_resume" },
  },
  scopes: ["openid", "profile", "email"],
  claims: {
    openid: ["sub", "kosmy_board_access"],
    profile: ["name", "preferred_username", "locale"],
    email: ["email", "email_verified"],
  },
  /* Extension Kosmy : où une appli reliée envoie ses notifications (docs/notifications.md). */
  discovery: { claim_types_supported: ["normal"], kosmy_notifications_endpoint: `${config.publicUrl}/api/apps/notifications` },
  /* Les applis lisent souvent l'identité directement dans l'ID token. */
  conformIdTokenClaims: false,
  async findAccount(ctx, id) {
    const u = db.prepare("SELECT id, email, name, lang FROM users WHERE id = ?").get(id);
    if (!u) return undefined;
    const clientId = ctx?.oidc?.client?.clientId;
    return {
      accountId: u.id,
      async claims() {
        return {
          sub: u.id,
          name: u.name,
          preferred_username: u.email,
          email: u.email,
          // Le Board ne vérifie pas les adresses e-mail : les applis doivent relier les comptes par « sub ».
          email_verified: false,
          ...(u.lang ? { locale: u.lang } : {}),
          // Accès géré par le Board : l'appli applique ce rôle et ces restrictions à la connexion.
          ...(() => {
            const access = isMcpClientId(clientId) ? null : accessClaim(u.id, clientId);
            return access ? { kosmy_board_access: access } : {};
          })(),
        };
      },
    };
  },
  interactions: {
    policy,
    url: (ctx, interaction) => `${MOUNT}/interaction/${interaction.uid}`,
  },
  features: {
    devInteractions: { enabled: false },
    revocation: { enabled: true },
    rpInitiatedLogout: {
      enabled: true,
      async logoutSource(ctx, form) {
        const lang = pageLang(ctx.req, currentUser(ctx.req));
        const t = tr(lang);
        const app = esc(ctx.oidc.client ? clientName(ctx.oidc.client.clientId) : ctx.host);
        sendPage(ctx, page({
          lang, kicker: "Kosmy Board", title: t.logout,
          body: `<p class="lead">${t.logoutText(app)}</p>${form}
            <div class="form-actions">
              <button class="btn signal" type="submit" form="op.logoutForm" value="yes" name="logout" autofocus>${t.logoutYes}</button>
              <button class="btn ghost" type="submit" form="op.logoutForm">${t.logoutNo}</button>
            </div>`,
        }));
      },
      async postLogoutSuccessSource(ctx) {
        const lang = pageLang(ctx.req, currentUser(ctx.req));
        const t = tr(lang);
        const app = esc(ctx.oidc.client ? clientName(ctx.oidc.client.clientId) : "");
        sendPage(ctx, page({ lang, kicker: "Kosmy Board", title: t.loggedOut, body: `<p class="lead">${t.loggedOutText(app)}</p>` }));
      },
    },
    /*
     * Serveur MCP (docs/assistant.md) : un client MCP (Claude, Claude Desktop…) s'inscrit lui-même,
     * puis la personne se connecte au Board et donne son accord. Ses jetons valent seulement pour /mcp.
     */
    registration: {
      enabled: true,
      idFactory: () => `mcp-${randomBytes(16).toString("base64url")}`,
    },
    resourceIndicators: {
      enabled: true,
      defaultResource: (ctx, client, oneOf) => oneOf ?? (isMcpClientId(client?.clientId) ? MCP_RESOURCE : undefined),
      useGrantedResource: () => true,
      getResourceServerInfo(ctx, resourceIndicator, client) {
        if (resourceIndicator !== MCP_RESOURCE || !isMcpClientId(client?.clientId)) throw new errors.InvalidTarget();
        return { scope: MCP_SCOPE, audience: MCP_RESOURCE, accessTokenTTL: 3600, accessTokenFormat: "jwt", jwt: { sign: { alg: "RS256" } } };
      },
    },
  },
  /* Les instances reliées et les clients MCP n'utilisent que le flux « code ». */
  responseTypes: ["code"],
  pkce: {
    // PKCE obligatoire pour les clients sans secret et pour tous les clients MCP ; conseillé (et accepté) pour les autres.
    required: (ctx, client) => client.tokenEndpointAuthMethod === "none" || isMcpClientId(client.clientId),
  },
  /* Jeton de rafraîchissement : seulement pour un client MCP qui l'a demandé à son inscription. */
  issueRefreshToken: (ctx, client) => isMcpClientId(client.clientId) && client.grantTypeAllowed("refresh_token"),
  ttl: {
    AccessToken: 3600,
    AuthorizationCode: 60,
    IdToken: 3600,
    Interaction: 600,
    Session: 14 * 86_400,
    Grant: (ctx, grant) => (isMcpClientId(grant.clientId) ? 90 * 86_400 : 14 * 86_400),
    RefreshToken: 30 * 86_400,
  },
  /* Les pages de la connexion unique ne sont jamais appelées depuis un autre site ; un client MCP peut l'être (inspecteur MCP…). */
  clientBasedCORS: (ctx, origin, client) => isMcpClientId(client?.clientId),
  async renderError(ctx, out) {
    const lang = pageLang(ctx.req, currentUser(ctx.req));
    const t = tr(lang);
    sendPage(ctx, page({
      lang, kicker: "Kosmy Board", title: t.error,
      body: `<p class="lead">${t.errorText}</p>
        <p class="note mono">${t.details} : ${esc(out.error)}${out.error_description ? ` — ${esc(out.error_description)}` : ""}</p>
        <div class="form-actions"><a class="btn ghost" href="/">${t.toBoard}</a></div>`,
    }), ctx.status >= 400 ? ctx.status : 400);
  },
});
provider.proxy = config.trustProxy;
provider.on("server_error", (ctx, err) => console.error("OpenID Connect :", err));

/* ---------- Interactions : la session du Board fait foi ---------- */

async function handleInteraction(req, res, uid, action) {
  const details = await provider.interactionDetails(req, res);
  if (details.uid !== uid) throw new Error("interaction");
  const user = currentUser(req);
  const clientId = details.params.client_id;
  const app = clientName(clientId);

  // Pas connecté au Board : on passe par sa page de connexion, puis on revient ici.
  if (!user) {
    const back = `${MOUNT}/interaction/${uid}`;
    res.writeHead(303, { Location: `/#/?retour=${encodeURIComponent(back)}&appli=${encodeURIComponent(app)}` }).end();
    return;
  }

  const mcp = isMcpClientId(clientId);
  if (action === "abort") {
    if (req.method !== "POST" || !sameOrigin(req)) {
      res.writeHead(405).end();
      return;
    }
    const description = mcp ? "The person refused access to Kosmy Board" : "No Kosmy Board space is linked to this app";
    await provider.interactionFinished(req, res, { error: "access_denied", error_description: description }, { mergeWithLastSubmission: false });
    return;
  }

  if (!mcp && !userHasClient(user.id, clientId)) {
    const lang = pageLang(req, user);
    const t = tr(lang);
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page({
      lang, kicker: "Kosmy Board", title: t.denied,
      body: `<p class="lead">${t.deniedText(esc(app))}</p>
        <form method="post" action="${MOUNT}/interaction/${esc(uid)}/abort" class="form-actions">
          <button class="btn signal" type="submit">${t.deniedBack(esc(app))}</button>
          <a class="link" href="/">${t.toBoard}</a>
        </form>`,
    }));
    return;
  }

  // Première étape : l'identité (celle du Board), avec la double authentification si elle est activée.
  if (details.prompt.name === "login" || details.session?.accountId !== user.id) {
    const amr = user.totp ? ["pwd", "otp"] : ["pwd"];
    await provider.interactionFinished(req, res, { login: { accountId: user.id, amr, remember: true } }, { mergeWithLastSubmission: false });
    return;
  }

  // Client MCP : la personne doit donner son accord, sur une page du Board (formulaire envoyé à ce même Board).
  if (mcp && action !== "confirm") {
    const lang = pageLang(req, user);
    const t = tr(lang);
    let host = "";
    try {
      host = new URL(details.params.redirect_uri).host;
    } catch { /* adresse absente */ }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page({
      lang, kicker: "Kosmy Board · MCP", title: t.mcpTitle,
      body: `<p class="lead">${t.mcpText(esc(app), esc(user.name))}</p>
        <p class="note mono">${t.mcpReturn} : ${esc(host)}</p>
        <p class="note">${t.mcpWarn}</p>
        <div class="form-actions">
          <form method="post" action="${MOUNT}/interaction/${esc(uid)}/confirm"><button class="btn signal" type="submit" autofocus>${t.mcpAllow}</button></form>
          <form method="post" action="${MOUNT}/interaction/${esc(uid)}/abort"><button class="btn ghost" type="submit">${t.mcpDeny}</button></form>
        </div>`,
    }));
    return;
  }
  if (mcp && (req.method !== "POST" || !sameOrigin(req))) {
    res.writeHead(405).end();
    return;
  }

  // Seconde étape : le consentement, donné d'office pour une instance reliée (l'espace relié vaut accord),
  // après la page d'accord pour un client MCP.
  const { missingOIDCScope, missingOIDCClaims, missingResourceScopes } = details.prompt.details;
  const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: user.id, clientId });
  if (missingOIDCScope) grant.addOIDCScope(missingOIDCScope.join(" "));
  if (missingOIDCClaims) grant.addOIDCClaims(missingOIDCClaims);
  if (missingResourceScopes) for (const [indicator, scopes] of Object.entries(missingResourceScopes)) grant.addResourceScope(indicator, scopes.join(" "));
  const grantId = await grant.save();
  await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
}

const callback = provider.callback();

/** Toutes les requêtes sous /oidc arrivent ici. */
export async function handleOidc(req, res, pathname) {
  const m = pathname.match(/^\/oidc\/interaction\/([\w-]{1,64})(?:\/(abort|confirm))?$/);
  if (m) {
    try {
      await handleInteraction(req, res, m[1], m[2]);
    } catch (e) {
      if (!res.headersSent) {
        const lang = pageLang(req, currentUser(req));
        const t = tr(lang);
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(page({ lang, kicker: "Kosmy Board", title: t.error, body: `<p class="lead">${t.errorText}</p><p class="note mono">${t.details} : ${esc(e.name || "interaction")}</p><div class="form-actions"><a class="btn ghost" href="/">${t.toBoard}</a></div>` }));
      }
    }
    return;
  }
  // Un client MCP qui ne demande aucune portée reçoit celle du serveur MCP (sinon il n'y aurait rien à accorder).
  if (pathname === `${MOUNT}/auth` && req.method === "GET") {
    const u = new URL(req.url, "http://board");
    if (isMcpClientId(u.searchParams.get("client_id")) && !u.searchParams.get("scope")) {
      u.searchParams.set("scope", MCP_SCOPE);
      req.url = `${u.pathname}${u.search}`;
    }
  }
  // oidc-provider est monté sous /oidc : il voit l'adresse sans ce préfixe.
  req.originalUrl = req.url;
  req.url = req.url.slice(MOUNT.length) || "/";
  callback(req, res);
}

/**
 * Métadonnées du serveur d'autorisation à la racine du domaine (RFC 8414 : /.well-known/oauth-authorization-server/oidc),
 * là où les clients MCP les cherchent : le même document que la découverte OpenID Connect.
 */
export function serveAuthServerMetadata(req, res) {
  req.originalUrl = `${MOUNT}/.well-known/openid-configuration`;
  req.url = "/.well-known/openid-configuration";
  callback(req, res);
}

export { clientBase };

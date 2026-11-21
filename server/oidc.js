/*
 * Connexion unique : Kosmy Board est un fournisseur d'identité OpenID Connect (bibliothèque oidc-provider, certifiée).
 *
 * - Chaque instance reliée au Board est un « client » (sso_clients), partagé par toutes les personnes du Board
 *   qui ont un espace pour cette instance.
 * - On ne se connecte à une instance par le Board que si l'on a, dans son Board, un espace relié à ce client.
 * - Il faut aussi être connecté au Board lui-même : se déconnecter du Board coupe les nouvelles connexions aux applis.
 */
import { generateKeyPairSync, randomBytes, createHash } from "node:crypto";

import Provider, { interactionPolicy } from "oidc-provider";

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
      return row ? clientMetadata(row) : undefined;
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

/** La personne a-t-elle, dans son Board, un espace relié à ce client ? */
export const userHasClient = (userId, clientId) =>
  Boolean(db.prepare("SELECT 1 FROM spaces WHERE user_id = ? AND client_id = ?").get(userId, clientId));

const clientName = (clientId) => db.prepare("SELECT name FROM sso_clients WHERE client_id = ?").get(clientId)?.name ?? clientId;
const clientBase = (clientId) => db.prepare("SELECT base FROM sso_clients WHERE client_id = ?").get(clientId)?.base ?? null;

/* ---------- Le fournisseur ---------- */

const { base: basePolicy, Check } = interactionPolicy;
const policy = basePolicy();
/* Même si oidc-provider garde sa propre session, chaque connexion à une appli exige la session du Board et le droit d'accès. */
policy.get("login").checks.add(new Check("kosmy_board", "Kosmy Board session and access are required", (ctx) => {
  const user = currentUser(ctx.req);
  if (!user || user.id !== ctx.oidc.session?.accountId) return Check.REQUEST_PROMPT;
  if (!userHasClient(user.id, ctx.oidc.client.clientId)) return Check.REQUEST_PROMPT;
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
    openid: ["sub"],
    profile: ["name", "preferred_username", "locale"],
    email: ["email", "email_verified"],
  },
  /* Les applis lisent souvent l'identité directement dans l'ID token. */
  conformIdTokenClaims: false,
  async findAccount(ctx, id) {
    const u = db.prepare("SELECT id, email, name, lang FROM users WHERE id = ?").get(id);
    if (!u) return undefined;
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
  },
  pkce: {
    // PKCE obligatoire pour les clients sans secret ; conseillé (et accepté) pour les autres.
    required: (ctx, client) => client.tokenEndpointAuthMethod === "none",
  },
  ttl: {
    AccessToken: 3600,
    AuthorizationCode: 60,
    IdToken: 3600,
    Interaction: 600,
    Session: 14 * 86_400,
    Grant: 14 * 86_400,
  },
  clientBasedCORS: () => false,
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

  if (action === "abort") {
    if (req.method !== "POST" || !sameOrigin(req)) {
      res.writeHead(405).end();
      return;
    }
    await provider.interactionFinished(req, res, { error: "access_denied", error_description: "No Kosmy Board space is linked to this app" }, { mergeWithLastSubmission: false });
    return;
  }

  if (!userHasClient(user.id, clientId)) {
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

  // Seconde étape : le consentement, donné d'office (l'espace relié vaut accord).
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
  const m = pathname.match(/^\/oidc\/interaction\/([\w-]{1,64})(?:\/(abort))?$/);
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
  // oidc-provider est monté sous /oidc : il voit l'adresse sans ce préfixe.
  req.originalUrl = req.url;
  req.url = req.url.slice(MOUNT.length) || "/";
  callback(req, res);
}

export { clientBase };

/*
 * Appli de démonstration : une « appli auto-hébergée » qui se connecte avec Kosmy Board (OpenID Connect).
 * C'est l'implémentation de référence de docs/integration.md, en un seul fichier, sans framework.
 *
 *   node examples/demo-app/server.js        → http://localhost:8768
 *
 * Réglages : page /settings (comme dans une vraie appli), gardés dans examples/demo-app/settings.json.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

import { createRemoteJWKSet, jwtVerify } from "jose";

const PORT = Number(process.env.PORT) || 8768;
const BASE = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const SETTINGS_FILE = new URL("./settings.json", import.meta.url);
const CALLBACK = `${BASE}/auth/kosmy-board/callback`;

let settings = { issuer: "http://localhost:8767/oidc", clientId: "", clientSecret: "" };
try { settings = { ...settings, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) }; } catch { /* premier lancement */ }

const sessions = new Map(); // jeton → { sub, name, email, at }
const pending = new Map(); // state → { verifier, nonce, target, exp }
const linked = new Map(); // sub du Board → compte local (ici : un simple nom)

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const b64url = (buf) => buf.toString("base64url");
const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length === 2));

/* ---------- Découverte OpenID Connect (mise en cache) ---------- */

let discovery = null, jwks = null, discoveredFor = "";
async function discover() {
  if (discovery && discoveredFor === settings.issuer) return discovery;
  const res = await fetch(`${settings.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`découverte impossible (${res.status})`);
  discovery = await res.json();
  if (discovery.issuer !== settings.issuer) throw new Error("l'émetteur annoncé ne correspond pas");
  jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  discoveredFor = settings.issuer;
  return discovery;
}

/* ---------- Pages ---------- */

function layout(title, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Démo</title>
<style>
  body{margin:0;font:16px/1.6 system-ui,sans-serif;background:#f4f1ea;color:#1d1b17}
  header{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;background:#22d3ee;color:#04161a}
  header b{font-size:20px} main{max-width:720px;margin:40px auto;padding:0 20px}
  .card{background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 0 rgba(0,0,0,.06);margin-bottom:20px}
  .btn{display:inline-block;padding:12px 20px;border-radius:999px;border:0;background:#0d0c0a;color:#f1ede4;font:600 15px system-ui;cursor:pointer;text-decoration:none}
  .btn.kosmy{background:#0d0c0a;color:#c5f04a} .btn.ghost{background:none;color:#1d1b17;box-shadow:inset 0 0 0 1px #1d1b1733}
  label{display:block;font:12px ui-monospace,monospace;text-transform:uppercase;margin-top:16px;color:#6f695d}
  input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #1d1b1733;border-radius:8px;font:14px ui-monospace,monospace}
  code{font:13px ui-monospace,monospace;background:#0001;padding:2px 6px;border-radius:4px;word-break:break-all}
  .err{color:#b42318} small{color:#6f695d}
</style></head><body><header><b>Démo · appli auto-hébergée</b><span>${esc(BASE)}</span></header><main>${body}</main></body></html>`;
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(html);
}
const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };

function currentUser(req) {
  const s = sessions.get(cookies(req).demo_session);
  return s || null;
}

/* ---------- Connexion avec Kosmy Board ---------- */

/**
 * Démarre la connexion. Appelée par le bouton de la page de connexion, ou directement par le Board
 * (« Ouvrir » : connexion initiée par un tiers, paramètres iss et target_link_uri).
 */
async function startLogin(req, res, url) {
  if (!settings.clientId) return redirect(res, "/settings");
  const iss = url.searchParams.get("iss");
  if (iss && iss !== settings.issuer) return send(res, 400, layout("Erreur", `<p class="err">Émetteur inconnu : ${esc(iss)}</p>`));
  // On ne revient que sur une page de cette appli.
  let target = "/admin";
  const t = url.searchParams.get("target_link_uri");
  if (t) {
    try {
      const u = new URL(t, BASE);
      if (u.origin === new URL(BASE).origin) target = u.pathname + u.search;
    } catch { /* adresse ignorée */ }
  }
  const d = await discover();
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  pending.set(state, { verifier, nonce, target, exp: Date.now() + 10 * 60_000 });
  const auth = new URL(d.authorization_endpoint);
  auth.search = new URLSearchParams({
    client_id: settings.clientId,
    response_type: "code",
    scope: "openid profile email",
    redirect_uri: CALLBACK,
    state,
    nonce,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  redirect(res, auth.href);
}

async function callback(req, res, url) {
  const state = url.searchParams.get("state");
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.exp < Date.now()) return send(res, 400, layout("Erreur", `<p class="err">Connexion expirée ou inconnue. <a href="/login">Recommencer</a></p>`));
  if (url.searchParams.get("error")) {
    return send(res, 403, layout("Refusé", `<div class="card"><p class="err">Kosmy Board a refusé la connexion : ${esc(url.searchParams.get("error_description") || url.searchParams.get("error"))}</p><a class="btn ghost" href="/login">Retour</a></div>`));
  }
  const d = await discover();
  // RFC 9207 : la réponse doit venir de l'émetteur attendu.
  if (url.searchParams.get("iss") && url.searchParams.get("iss") !== d.issuer) return send(res, 400, layout("Erreur", `<p class="err">Émetteur inattendu.</p>`));

  const tokenRes = await fetch(d.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: CALLBACK, code_verifier: p.verifier }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || !tokens.id_token) return send(res, 400, layout("Erreur", `<p class="err">Échange du code refusé : ${esc(tokens.error_description || tokens.error)}</p>`));

  const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: d.issuer, audience: settings.clientId });
  if (!payload.nonce || !timingSafeEqual(Buffer.from(String(payload.nonce)), Buffer.from(p.nonce))) {
    return send(res, 400, layout("Erreur", `<p class="err">Nonce invalide.</p>`));
  }
  // Les comptes se relient par « sub » (identifiant stable du Board), jamais par l'e-mail (non vérifié).
  if (!linked.has(payload.sub)) linked.set(payload.sub, payload.name || payload.email);
  const sid = b64url(randomBytes(24));
  sessions.set(sid, { sub: payload.sub, name: payload.name, email: payload.email, at: Date.now() });
  redirect(res, p.target, { "Set-Cookie": `demo_session=${sid}; Path=/; HttpOnly; SameSite=Lax` });
}

/* ---------- Routes ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  try {
    if (url.pathname === "/auth/kosmy-board/login") return await startLogin(req, res, url);
    if (url.pathname === "/auth/kosmy-board/callback") return await callback(req, res, url);

    if (url.pathname === "/settings") {
      if (req.method === "POST") {
        let body = "";
        for await (const c of req) body += c;
        const f = new URLSearchParams(body);
        settings = { issuer: f.get("issuer").trim().replace(/\/+$/, ""), clientId: f.get("clientId").trim(), clientSecret: f.get("clientSecret").trim() || settings.clientSecret };
        writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        discovery = null;
        return redirect(res, "/login");
      }
      return send(res, 200, layout("Réglages", `<div class="card"><h1>Réglages OpenID Connect</h1>
        <p>Collez ici les réglages affichés par Kosmy Board (page « Connexion unique » de l'espace).</p>
        <p><small>Adresse de retour à donner au Board : <code>${esc(CALLBACK)}</code><br>Adresse de lancement : <code>${esc(BASE)}/auth/kosmy-board/login</code></small></p>
        <form method="post">
          <label>Émetteur (issuer)</label><input name="issuer" value="${esc(settings.issuer)}" required>
          <label>Identifiant client</label><input name="clientId" value="${esc(settings.clientId)}" required>
          <label>Secret client ${settings.clientSecret ? "(laisser vide pour garder l'actuel)" : ""}</label><input name="clientSecret" type="password" autocomplete="off">
          <p><button class="btn" type="submit">Enregistrer</button></p>
        </form></div>`));
    }

    if (url.pathname === "/logout" && req.method === "POST") {
      sessions.delete(cookies(req).demo_session);
      return redirect(res, "/login", { "Set-Cookie": "demo_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" });
    }

    const user = currentUser(req);
    if (url.pathname === "/admin" || url.pathname === "/") {
      if (!user) return redirect(res, "/login");
      return send(res, 200, layout("Admin", `<div class="card"><h1>Administration</h1>
        <p>Bonjour <b>${esc(user.name)}</b> : vous êtes connecté avec Kosmy Board, sans mot de passe propre à cette appli.</p>
        <p><small>Identifiant Kosmy Board (sub) : <code>${esc(user.sub)}</code><br>E-mail : ${esc(user.email)}</small></p>
        <form method="post" action="/logout"><button class="btn ghost" type="submit">Se déconnecter de la démo</button></form></div>
        <p><small>Se déconnecter ici ferme la session de la démo. Votre session sur le Board reste ouverte : « Ouvrir » vous reconnecte d'un clic.</small></p>`));
    }

    if (url.pathname === "/login") {
      if (user) return redirect(res, "/admin");
      return send(res, 200, layout("Connexion", `<div class="card"><h1>Connexion</h1>
        <p>Cette appli de démonstration n'a pas de mot de passe : elle confie la connexion à Kosmy Board.</p>
        ${settings.clientId ? `<a class="btn kosmy" href="/auth/kosmy-board/login">Se connecter avec Kosmy Board</a>` : `<p class="err">La connexion unique n'est pas encore réglée.</p>`}
        <p><small><a href="/settings">Réglages OpenID Connect</a></small></p></div>`));
    }

    send(res, 404, layout("Introuvable", "<p>Page introuvable.</p>"));
  } catch (e) {
    console.error(e);
    send(res, 500, layout("Erreur", `<p class="err">${esc(e.message)}</p>`));
  }
});

server.listen(PORT, () => console.log(`Appli de démo : ${BASE} (émetteur : ${settings.issuer || "à régler"})`));

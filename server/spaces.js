/*
 * Espaces, connexion unique, admin dans le Board et membres : la logique partagée par les routes /api
 * (server/api.js), l'Assistant (server/ai/tools.js) et le serveur MCP (server/mcp.js).
 * Chaque fonction reçoit la personne connectée et applique les mêmes règles, quelle que soit la porte d'entrée.
 */
import { randomBytes } from "node:crypto";

import { isLocalHost, normalizeBase, normalizePath } from "../public/js/normalize.js";
import { sha256, token } from "./auth.js";
import { callApp, SECTION_ID } from "./admin.js";
import { config } from "./config.js";
import { db, tx } from "./db.js";
import { bad, HttpError } from "./http.js";
import { ISSUER, provider } from "./oidc.js";

const DAY = 86_400_000;
export const INVITE_DAYS = 7;
export const MAX_SPACES = 500;

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const newSpaceId = () => `${Date.now().toString(36)}${randomBytes(4).toString("hex").slice(0, 5)}`;

/* ---------- Espaces ---------- */

/** Un espace reçu de l'interface ou d'un fichier importé. */
export function cleanSpace(raw) {
  if (!raw || typeof raw !== "object") throw bad("space");
  const appId = raw.appId == null || raw.appId === "" ? null : String(raw.appId);
  if (appId !== null && !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(appId)) throw bad("app");
  const name = str(raw.name, 80);
  if (!name) throw bad("name");
  const n = normalizeBase(raw.base);
  if ("error" in n) throw bad(n.error);
  const path = normalizePath(raw.path);
  if (!path) throw bad("path");
  return { appId, name, base: n.base, path };
}

/** Format AdminSpace de Kosmy Mobile, plus la connexion unique (sso) pour le Board. */
export const spaceOut = (r, withSso = true) => ({
  id: r.id, appId: r.app_id, name: r.name, base: r.base, path: r.path, addedAt: r.added_at,
  ...(r.opened_at ? { openedAt: r.opened_at } : {}),
  ...(withSso && r.client_id ? { sso: { loginUri: r.initiate_login_uri ?? null } } : {}),
});
const SPACE_SELECT = "SELECT s.*, c.initiate_login_uri FROM spaces s LEFT JOIN sso_clients c ON c.client_id = s.client_id";
export const getSpace = (userId, id) => db.prepare(`${SPACE_SELECT} WHERE s.user_id = ? AND s.id = ?`).get(userId, id);
export const listSpaceRows = (userId) =>
  db.prepare(`${SPACE_SELECT} WHERE s.user_id = ? ORDER BY COALESCE(s.opened_at, s.added_at) DESC`).all(userId);

export function createSpace(user, raw) {
  const s = cleanSpace(raw);
  if (db.prepare("SELECT COUNT(*) AS n FROM spaces WHERE user_id = ?").get(user.id).n >= MAX_SPACES) throw bad("too_many");
  const row = { id: newSpaceId(), added_at: Date.now() };
  db.prepare("INSERT INTO spaces (user_id, id, app_id, name, base, path, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(user.id, row.id, s.appId, s.name, s.base, s.path, row.added_at);
  return getSpace(user.id, row.id);
}

export function updateSpace(user, id, raw) {
  const s = cleanSpace(raw);
  const old = getSpace(user.id, id);
  if (!old) throw new HttpError(404, "not_found");
  tx(() => {
    db.prepare("UPDATE spaces SET app_id = ?, name = ?, base = ?, path = ? WHERE user_id = ? AND id = ?")
      .run(s.appId, s.name, s.base, s.path, user.id, id);
    // Nouvelle adresse : la connexion unique de l'ancienne instance ne vaut plus pour cet espace.
    if (old.client_id && old.base !== s.base) {
      db.prepare("UPDATE spaces SET client_id = NULL WHERE user_id = ? AND id = ?").run(user.id, id);
      dropOrphanClient(old.client_id);
    }
  });
  return getSpace(user.id, id);
}

export function deleteSpace(user, id) {
  const old = getSpace(user.id, id);
  if (!old) throw new HttpError(404, "not_found");
  tx(() => {
    db.prepare("DELETE FROM spaces WHERE user_id = ? AND id = ?").run(user.id, id);
    if (old.client_id) dropOrphanClient(old.client_id);
  });
}

/* ---------- Connexion unique (OpenID Connect) ---------- */

const AUTH_METHODS = new Set(["client_secret_basic", "client_secret_post"]);
/** Convention des applis Kosmy (voir docs/integration.md). */
export const kosmyDefaults = (base) => ({
  redirectUri: `${base}/auth/kosmy-board/callback`,
  initiateLoginUri: `${base}/auth/kosmy-board/login`,
});

/** Adresse de retour ou de lancement : http(s), sans fragment ni identifiant, https obligatoire hors réseau local. */
function cleanUri(v, code) {
  let u;
  try {
    u = new URL(str(v, 500));
  } catch {
    throw bad(code);
  }
  if (!/^https?:$/.test(u.protocol) || u.hash || u.username || u.password) throw bad(code);
  if (u.protocol === "http:" && !isLocalHost(u.host)) throw bad(`${code}_https`);
  return u.href;
}

function ssoInput(body) {
  const list = Array.isArray(body.redirectUris) ? body.redirectUris : [body.redirectUris];
  const redirectUris = [...new Set(list.filter((x) => typeof x === "string" && x.trim()).slice(0, 5).map((x) => cleanUri(x, "redirect_uri")))];
  if (!redirectUris.length) throw bad("redirect_uri");
  const initiateLoginUri = str(body.initiateLoginUri, 500) ? cleanUri(body.initiateLoginUri, "initiate_uri") : null;
  const authMethod = AUTH_METHODS.has(body.authMethod) ? body.authMethod : "client_secret_basic";
  return { redirectUris, initiateLoginUri, authMethod };
}

const canManage = (user, client) => user.role === "admin" || client.created_by === user.id;
const getClient = (clientId) => db.prepare("SELECT * FROM sso_clients WHERE client_id = ?").get(clientId);

function ssoOut(user, space, client, secret) {
  return {
    issuer: ISSUER,
    discovery: `${ISSUER}/.well-known/openid-configuration`,
    defaults: space.app_id ? kosmyDefaults(space.base) : null,
    enabled: Boolean(client),
    ...(client ? {
      clientId: client.client_id,
      redirectUris: JSON.parse(client.redirect_uris),
      initiateLoginUri: client.initiate_login_uri,
      authMethod: client.auth_method,
      canManage: canManage(user, client),
      secretAt: client.secret_at,
      sharedWith: db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM spaces WHERE client_id = ?").get(client.client_id).n,
    } : {}),
    ...(secret ? { secret } : {}),
  };
}

/** Plus aucun espace ne pointe vers ce client : on le supprime, avec ses jetons. */
export function dropOrphanClient(clientId) {
  if (db.prepare("SELECT 1 FROM spaces WHERE client_id = ?").get(clientId)) return;
  db.prepare("DELETE FROM sso_clients WHERE client_id = ?").run(clientId);
  db.prepare("DELETE FROM oidc_store WHERE json_extract(payload, '$.clientId') = ?").run(clientId);
}

function spaceForSso(user, id) {
  const space = getSpace(user.id, id);
  if (!space) throw new HttpError(404, "not_found");
  return { space, client: space.client_id ? getClient(space.client_id) : null };
}

/** oidc-provider valide les métadonnées du client : on vérifie qu'il est utilisable, sinon on annule. */
async function assertClientUsable(clientId, rollback) {
  try {
    await provider.Client.find(clientId);
  } catch (e) {
    rollback();
    throw bad("client_invalid", { detail: e.error_description || e.message });
  }
}

export function getSso(user, id) {
  const { space, client } = spaceForSso(user, id);
  // Une autre personne a peut-être déjà relié cette instance : l'appli est alors déjà réglée.
  const existing = client ? null : db.prepare("SELECT 1 FROM sso_clients WHERE base = ?").get(space.base);
  return { ...ssoOut(user, space, client), existing: Boolean(existing) };
}

/**
 * Activer : rejoint le client de cette instance s'il existe, sinon en crée un (son secret n'est montré qu'à ce moment).
 * Renvoie { status, sso }.
 */
export async function enableSso(user, id, body) {
  const { space, client } = spaceForSso(user, id);
  if (client) throw new HttpError(409, "sso_enabled");
  const existing = db.prepare("SELECT * FROM sso_clients WHERE base = ?").get(space.base);
  if (existing) {
    db.prepare("UPDATE spaces SET client_id = ? WHERE user_id = ? AND id = ?").run(existing.client_id, user.id, id);
    return { status: 200, sso: ssoOut(user, space, existing) };
  }
  const input = ssoInput(body);
  const secret = token(32);
  const clientId = `kb-${token(12)}`;
  const now = Date.now();
  tx(() => {
    db.prepare(
      `INSERT INTO sso_clients (client_id, base, name, app_id, secret, redirect_uris, initiate_login_uri, auth_method, created_by, created_at, secret_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(clientId, space.base, space.name, space.app_id, secret, JSON.stringify(input.redirectUris), input.initiateLoginUri, input.authMethod, user.id, now, now);
    db.prepare("UPDATE spaces SET client_id = ? WHERE user_id = ? AND id = ?").run(clientId, user.id, id);
  });
  await assertClientUsable(clientId, () => tx(() => {
    db.prepare("UPDATE spaces SET client_id = NULL WHERE client_id = ?").run(clientId);
    db.prepare("DELETE FROM sso_clients WHERE client_id = ?").run(clientId);
  }));
  return { status: 201, sso: ssoOut(user, space, getClient(clientId), secret) };
}

export async function updateSso(user, id, body) {
  const input = ssoInput(body);
  const { space, client } = spaceForSso(user, id);
  if (!client) throw new HttpError(404, "sso_disabled");
  if (!canManage(user, client)) throw new HttpError(403, "sso_manage");
  const update = db.prepare("UPDATE sso_clients SET redirect_uris = ?, initiate_login_uri = ?, auth_method = ? WHERE client_id = ?");
  update.run(JSON.stringify(input.redirectUris), input.initiateLoginUri, input.authMethod, client.client_id);
  await assertClientUsable(client.client_id, () =>
    update.run(client.redirect_uris, client.initiate_login_uri, client.auth_method, client.client_id));
  return ssoOut(user, space, getClient(client.client_id));
}

/** Nouveau secret : l'ancien cesse de fonctionner tout de suite. */
export function rotateSsoSecret(user, id) {
  const { space, client } = spaceForSso(user, id);
  if (!client) throw new HttpError(404, "sso_disabled");
  if (!canManage(user, client)) throw new HttpError(403, "sso_manage");
  const secret = token(32);
  db.prepare("UPDATE sso_clients SET secret = ?, secret_at = ? WHERE client_id = ?").run(secret, Date.now(), client.client_id);
  return ssoOut(user, space, getClient(client.client_id), secret);
}

/** Désactiver pour cet espace. Le client disparaît quand plus personne ne l'utilise. */
export function disableSso(user, id) {
  const { client } = spaceForSso(user, id);
  if (!client) throw new HttpError(404, "sso_disabled");
  tx(() => {
    db.prepare("UPDATE spaces SET client_id = NULL WHERE user_id = ? AND id = ?").run(user.id, id);
    dropOrphanClient(client.client_id);
  });
}

/* ---------- Admin dans le Board (docs/admin-api.md) ---------- */

/** L'admin dans le Board passe par la connexion unique : l'appli reconnaît la personne par son « sub ». */
export function spaceForAdmin(user, id) {
  const space = getSpace(user.id, id);
  if (!space) throw new HttpError(404, "not_found");
  if (!space.client_id) throw new HttpError(409, "admin_no_sso");
  return space;
}
export function sectionId(v) {
  if (!SECTION_ID.test(v)) throw new HttpError(404, "admin_not_found");
  return v;
}
/** Appelle l'API d'admin de l'instance au nom de la personne. */
export const appCall = (user, space, lang, opts = {}) =>
  callApp({ base: space.base, clientId: space.client_id, user, lang, ...opts });

/* ---------- Membres et invitations (administrateurs du Board) ---------- */

export function listMembers() {
  const users = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.created_at, (SELECT COUNT(*) FROM spaces s WHERE s.user_id = u.id) AS spaces
       FROM users u ORDER BY u.created_at`,
  ).all();
  const invites = db.prepare("SELECT id, role, created_at, expires_at FROM invites WHERE expires_at > ? ORDER BY created_at DESC")
    .all(Date.now());
  return {
    users: users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, spaces: u.spaces })),
    invites: invites.map((i) => ({ id: i.id, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at })),
  };
}

/** Le lien n'est montré qu'une fois : seul son haché est conservé. */
export function createInvite(user, role) {
  const r = role === "admin" ? "admin" : "member";
  const raw = token(24);
  const id = newSpaceId();
  const now = Date.now();
  db.prepare("INSERT INTO invites (id, token_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, sha256(raw), r, user.id, now, now + INVITE_DAYS * DAY);
  return { id, url: `${config.publicUrl}/#/invitation/${raw}`, expiresAt: now + INVITE_DAYS * DAY };
}

export function deleteInvite(id) {
  db.prepare("DELETE FROM invites WHERE id = ?").run(id);
}

export function removeMember(user, id) {
  if (id === user.id) throw bad("self");
  const clients = db.prepare("SELECT DISTINCT client_id FROM spaces WHERE user_id = ? AND client_id IS NOT NULL").all(id);
  tx(() => {
    const r = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    if (!r.changes) throw new HttpError(404, "not_found");
    // Ses sessions et autorisations de connexion unique disparaissent avec lui.
    db.prepare("DELETE FROM oidc_store WHERE json_extract(payload, '$.accountId') = ?").run(id);
    for (const c of clients) dropOrphanClient(c.client_id);
  });
}

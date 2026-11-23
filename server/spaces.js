/*
 * Espaces (instances), connexion unique, admin dans le Board et membres : la logique partagée par les routes /api
 * (server/api.js), l'Assistant (server/ai/tools.js) et le serveur MCP (server/mcp.js).
 * Chaque fonction reçoit la personne connectée et applique les mêmes règles, quelle que soit la porte d'entrée.
 *
 * Une instance est commune au Board : un administrateur du Board l'ajoute et choisit qui y a accès
 * (server/access.js). Les administrateurs du Board voient toutes les instances ; les autres, seulement
 * celles où ils ont un accès.
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

export const isBoardAdmin = (user) => user?.role === "admin";
export function requireAdmin(user) {
  if (!isBoardAdmin(user)) throw new HttpError(403, "admin");
}

/* ---------- Espaces (instances) ---------- */

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

/** Format AdminSpace de Kosmy Mobile, plus la connexion unique (sso) et le rôle de la personne (access) pour le Board. */
export const spaceOut = (r, withSso = true) => ({
  id: r.id, appId: r.app_id, name: r.name, base: r.base, path: r.path, addedAt: r.added_at,
  ...(r.opened_at ? { openedAt: r.opened_at } : {}),
  ...(withSso && r.client_id ? { sso: { loginUri: r.initiate_login_uri ?? null } } : {}),
  ...(withSso && r.access_role ? { access: { role: r.access_role, label: r.access_label || r.access_role, admin: Boolean(r.access_admin) } } : {}),
});

const spaceSelect = (onlyWithAccess) => `
  SELECT i.id, i.app_id, i.name, i.base, i.path, i.client_id, i.created_at AS added_at, c.initiate_login_uri,
         o.at AS opened_at, a.role AS access_role, a.role_label AS access_label, a.role_admin AS access_admin
    FROM instances i
    LEFT JOIN sso_clients c ON c.client_id = i.client_id
    ${onlyWithAccess ? "JOIN" : "LEFT JOIN"} access a ON a.instance_id = i.id AND a.user_id = $user AND a.revoked = 0
    LEFT JOIN opened o ON o.instance_id = i.id AND o.user_id = $user`;

/** Un espace que la personne peut voir, ou undefined. */
export const getSpace = (user, id) =>
  db.prepare(`${spaceSelect(!isBoardAdmin(user))} WHERE i.id = $id`).get({ user: user.id, id });
/** Les espaces que la personne peut voir, les plus récemment ouverts d'abord. */
export const listSpaceRows = (user) =>
  db.prepare(`${spaceSelect(!isBoardAdmin(user))} ORDER BY COALESCE(o.at, i.created_at) DESC`).all({ user: user.id });
export const getInstance = (id) => db.prepare("SELECT * FROM instances WHERE id = ?").get(id);

export function createSpace(user, raw) {
  requireAdmin(user);
  const s = cleanSpace(raw);
  if (db.prepare("SELECT COUNT(*) AS n FROM instances").get().n >= MAX_SPACES) throw bad("too_many");
  if (db.prepare("SELECT 1 FROM instances WHERE base = ?").get(s.base)) throw new HttpError(409, "space_exists");
  const id = newSpaceId();
  db.prepare("INSERT INTO instances (id, app_id, name, base, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, s.appId, s.name, s.base, s.path, user.id, Date.now());
  return getSpace(user, id);
}

export function updateSpace(user, id, raw) {
  requireAdmin(user);
  const s = cleanSpace(raw);
  const old = getInstance(id);
  if (!old) throw new HttpError(404, "not_found");
  if (old.base !== s.base && db.prepare("SELECT 1 FROM instances WHERE base = ? AND id <> ?").get(s.base, id)) {
    throw new HttpError(409, "space_exists");
  }
  tx(() => {
    db.prepare("UPDATE instances SET app_id = ?, name = ?, base = ?, path = ? WHERE id = ?").run(s.appId, s.name, s.base, s.path, id);
    // Nouvelle adresse : la connexion unique de l'ancienne instance ne vaut plus.
    if (old.client_id && old.base !== s.base) {
      db.prepare("UPDATE instances SET client_id = NULL WHERE id = ?").run(id);
      dropOrphanClient(old.client_id);
    }
  });
  return getSpace(user, id);
}

/** Retire l'instance du Board, pour tout le monde (l'instance elle-même et ses comptes ne sont pas touchés). */
export function deleteSpace(user, id) {
  requireAdmin(user);
  const old = getInstance(id);
  if (!old) throw new HttpError(404, "not_found");
  tx(() => {
    db.prepare("DELETE FROM instances WHERE id = ?").run(id);
    if (old.client_id) dropOrphanClient(old.client_id);
  });
}

/** Dernière ouverture, propre à chaque personne. */
export function markOpened(user, id) {
  if (!getSpace(user, id)) throw new HttpError(404, "not_found");
  const now = Date.now();
  db.prepare("INSERT INTO opened (user_id, instance_id, at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET at = excluded.at").run(user.id, id, now);
  return now;
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

const getClient = (clientId) => db.prepare("SELECT * FROM sso_clients WHERE client_id = ?").get(clientId);

/** Personnes qui peuvent se connecter à l'instance par le Board : celles qui y ont accès, et les administrateurs du Board. */
const peopleWithAccess = (instanceId) => db.prepare(
  `SELECT COUNT(*) AS n FROM users u WHERE u.role = 'admin'
      OR EXISTS (SELECT 1 FROM access a WHERE a.instance_id = ? AND a.user_id = u.id AND a.revoked = 0)`,
).get(instanceId).n;

function ssoOut(space, client, secret) {
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
      canManage: true,
      secretAt: client.secret_at,
      sharedWith: peopleWithAccess(space.id),
    } : {}),
    ...(secret ? { secret } : {}),
  };
}

/** Plus aucune instance ne pointe vers ce client : on le supprime, avec ses jetons. */
export function dropOrphanClient(clientId) {
  if (db.prepare("SELECT 1 FROM instances WHERE client_id = ?").get(clientId)) return;
  db.prepare("DELETE FROM sso_clients WHERE client_id = ?").run(clientId);
  db.prepare("DELETE FROM oidc_store WHERE json_extract(payload, '$.clientId') = ?").run(clientId);
}

/** La connexion unique d'une instance se règle par un administrateur du Board. */
function spaceForSso(user, id) {
  requireAdmin(user);
  const space = getSpace(user, id);
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
  return { ...ssoOut(space, client), existing: false };
}

/** Activer : crée le client OpenID Connect de l'instance (son secret n'est montré qu'à ce moment). Renvoie { status, sso }. */
export async function enableSso(user, id, body) {
  const { space, client } = spaceForSso(user, id);
  if (client) throw new HttpError(409, "sso_enabled");
  const input = ssoInput(body);
  const secret = token(32);
  const clientId = `kb-${token(12)}`;
  const now = Date.now();
  tx(() => {
    // Un ancien client resté pour cette adresse : remplacé (l'adresse est unique parmi les clients).
    const stale = db.prepare("SELECT client_id FROM sso_clients WHERE base = ?").get(space.base);
    if (stale) {
      db.prepare("DELETE FROM sso_clients WHERE client_id = ?").run(stale.client_id);
      db.prepare("DELETE FROM oidc_store WHERE json_extract(payload, '$.clientId') = ?").run(stale.client_id);
    }
    db.prepare(
      `INSERT INTO sso_clients (client_id, base, name, app_id, secret, redirect_uris, initiate_login_uri, auth_method, created_by, created_at, secret_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(clientId, space.base, space.name, space.app_id, secret, JSON.stringify(input.redirectUris), input.initiateLoginUri, input.authMethod, user.id, now, now);
    db.prepare("UPDATE instances SET client_id = ? WHERE id = ?").run(clientId, id);
  });
  await assertClientUsable(clientId, () => tx(() => {
    db.prepare("UPDATE instances SET client_id = NULL WHERE client_id = ?").run(clientId);
    db.prepare("DELETE FROM sso_clients WHERE client_id = ?").run(clientId);
  }));
  return { status: 201, sso: ssoOut(space, getClient(clientId), secret) };
}

export async function updateSso(user, id, body) {
  const input = ssoInput(body);
  const { space, client } = spaceForSso(user, id);
  if (!client) throw new HttpError(404, "sso_disabled");
  const update = db.prepare("UPDATE sso_clients SET redirect_uris = ?, initiate_login_uri = ?, auth_method = ? WHERE client_id = ?");
  update.run(JSON.stringify(input.redirectUris), input.initiateLoginUri, input.authMethod, client.client_id);
  await assertClientUsable(client.client_id, () =>
    update.run(client.redirect_uris, client.initiate_login_uri, client.auth_method, client.client_id));
  return ssoOut(space, getClient(client.client_id));
}

/** Nouveau secret : l'ancien cesse de fonctionner tout de suite. */
export function rotateSsoSecret(user, id) {
  const { space, client } = spaceForSso(user, id);
  if (!client) throw new HttpError(404, "sso_disabled");
  const secret = token(32);
  db.prepare("UPDATE sso_clients SET secret = ?, secret_at = ? WHERE client_id = ?").run(secret, Date.now(), client.client_id);
  return ssoOut(space, getClient(client.client_id), secret);
}

/** Désactiver : le client disparaît, pour tout le monde. */
export function disableSso(user, id) {
  const { client } = spaceForSso(user, id);
  if (!client) throw new HttpError(404, "sso_disabled");
  tx(() => {
    db.prepare("UPDATE instances SET client_id = NULL WHERE id = ?").run(id);
    dropOrphanClient(client.client_id);
  });
}

/* ---------- Admin dans le Board (docs/admin-api.md) ---------- */

/** L'admin dans le Board passe par la connexion unique : l'appli reconnaît la personne par son « sub ». */
export function spaceForAdmin(user, id) {
  const space = getSpace(user, id);
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
    `SELECT u.id, u.email, u.name, u.role, u.created_at, u.password_hash = '' AS pending,
            (SELECT COUNT(*) FROM access a WHERE a.user_id = u.id AND a.revoked = 0) AS spaces
       FROM users u ORDER BY u.created_at`,
  ).all();
  const invites = db.prepare("SELECT id, role, created_at, expires_at FROM invites WHERE expires_at > ? ORDER BY created_at DESC")
    .all(Date.now());
  return {
    users: users.map((u) => ({
      id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, spaces: u.spaces, pending: Boolean(u.pending),
    })),
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

/** Supprime le compte Board (les comptes dans les applis sont désactivés avant : voir removeUser dans server/access.js). */
export function removeMember(user, id) {
  if (id === user.id) throw bad("self");
  tx(() => {
    const r = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    if (!r.changes) throw new HttpError(404, "not_found");
    // Ses sessions et autorisations de connexion unique disparaissent avec lui.
    db.prepare("DELETE FROM oidc_store WHERE json_extract(payload, '$.accountId') = ?").run(id);
  });
}

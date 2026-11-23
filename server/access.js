/*
 * Utilisateurs gérés par le Board (docs/users-api.md, protocole kosmy.board-users.v1).
 *
 * Un administrateur du Board crée les comptes, choisit à quelles instances chaque personne a accès et, pour chaque
 * instance, son rôle et ses restrictions, tels que l'appli les décrit. Le Board retient ce choix (table « access »)
 * et le transmet à l'appli (PUT / DELETE signés, comme l'admin dans le Board), qui crée, met à jour ou désactive
 * le compte. L'appli revérifie tout : la personne qui agit doit être administratrice de l'appli.
 *
 * Un accès sans rôle (« non géré ») montre l'instance et permet de s'y connecter par le Board, sans toucher
 * au compte dans l'appli : c'est ce que deviennent les espaces d'avant, et ce qui reste possible pour une appli
 * qui ne propose pas ce protocole.
 */
import { checkPassword, hashPassword, newUserId, sha256, token } from "./auth.js";
import { callApp, cleanField } from "./admin.js";
import { config } from "./config.js";
import { db, tx } from "./db.js";
import { bad, HttpError } from "./http.js";
import { getInstance, listMembers, removeMember, requireAdmin } from "./spaces.js";

export const USERS_PATH = "/api/kosmy-board/users";
export const USERS_PROTOCOL = "kosmy.board-users.v1";
const LINK_DAYS = 7;
const DAY = 86_400_000;
const ROLE = /^[a-z0-9_-]{1,40}$/;
const SUB = /^[A-Za-z0-9-]{1,64}$/;

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/* ---------- Ce que l'appli propose ---------- */

/** Réponse de GET /api/kosmy-board/users, réduite à un format strict (rien d'autre ne va à l'interface). */
export function cleanUsersSchema(data) {
  if (!data || typeof data !== "object" || data.protocol !== USERS_PROTOCOL) throw new HttpError(502, "users_unsupported");
  const seen = new Set();
  const roles = list(data.roles, 10).map((r) => {
    if (!r || typeof r !== "object" || typeof r.value !== "string" || !ROLE.test(r.value) || seen.has(r.value)) return null;
    seen.add(r.value);
    return {
      value: r.value,
      label: text(r.label, 60) || r.value,
      ...(text(r.description, 200) ? { description: text(r.description, 200) } : {}),
      admin: r.admin === true,
    };
  }).filter(Boolean);
  if (!roles.length) throw new HttpError(502, "users_invalid");
  const roleValues = new Set(roles.map((r) => r.value));
  const fields = list(data.fields, 30).map((f) => {
    if (!f || typeof f !== "object" || f.type === "password") return null;
    const c = cleanField(f);
    if (!c) return null;
    const only = list(f.roles, 10).filter((r) => roleValues.has(r));
    return only.length ? { ...c, roles: only } : c;
  }).filter(Boolean);
  const users = list(data.users, 500).map((u) => {
    if (!u || typeof u !== "object" || typeof u.sub !== "string" || !SUB.test(u.sub)) return null;
    return {
      sub: u.sub,
      role: roleValues.has(u.role) ? u.role : null,
      values: u.values && typeof u.values === "object" && !Array.isArray(u.values) ? pickValues(fields, u.values) : {},
      active: u.active !== false,
      ...(text(u.account, 120) ? { account: text(u.account, 120) } : {}),
    };
  }).filter(Boolean);
  return {
    protocol: USERS_PROTOCOL,
    roles,
    defaultRole: roleValues.has(data.defaultRole) ? data.defaultRole : roles.at(-1).value,
    fields,
    users,
  };
}

/** Valeurs d'un compte telles que l'appli les annonce : seulement les champs connus, au bon type. */
function pickValues(fields, raw) {
  const out = {};
  for (const f of fields) {
    const v = raw[f.name];
    if (f.type === "checkbox" ? typeof v === "boolean" : f.type === "number" ? Number.isFinite(v) : typeof v === "string") out[f.name] = v;
  }
  return out;
}

const fieldsFor = (schema, role) => schema.fields.filter((f) => !f.roles || f.roles.includes(role));

/**
 * Valeurs choisies par l'administrateur pour ce rôle. Un champ absent garde sa valeur actuelle, sinon sa valeur
 * par défaut. Vérification de forme seulement : l'appli revérifie tout avec ses propres règles.
 */
function cleanValues(schema, role, raw, current) {
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) throw bad("access_values");
  const out = {};
  for (const f of fieldsFor(schema, role)) {
    let v = raw && f.name in raw ? raw[f.name] : current?.[f.name] ?? f.value;
    if (v === undefined || v === "") {
      if (f.required) throw bad("access_values", { field: f.label });
      continue;
    }
    if (f.type === "checkbox") {
      if (typeof v !== "boolean") throw bad("access_values", { field: f.label });
    } else if (f.type === "number") {
      if (typeof v === "string" && v.trim() !== "") v = Number(v);
      if (!Number.isFinite(v) || (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) {
        throw bad("access_values", { field: f.label });
      }
    } else {
      if (typeof v !== "string" || v.length > (f.type === "textarea" ? 20_000 : 2000)) throw bad("access_values", { field: f.label });
      if (f.type === "select" && !f.options.some((o) => o.value === v)) throw bad("access_values", { field: f.label });
    }
    out[f.name] = v;
  }
  return out;
}

/* ---------- Appels à l'appli ---------- */

/** Erreurs de l'appli qui veulent dire « refusé » (et pas « injoignable ») : rien n'est enregistré. */
const REFUSED = new Set(["admin_app_error", "admin_forbidden", "admin_not_linked", "admin_not_found", "admin_rejected"]);

async function callUsers(actor, inst, lang, { method = "GET", sub = "", body } = {}) {
  if (!inst.client_id) throw new HttpError(409, "access_no_sso");
  try {
    return await callApp({ base: inst.base, clientId: inst.client_id, user: actor, lang, method, section: sub, body, path: USERS_PATH });
  } catch (e) {
    if (e instanceof HttpError && e.code === "admin_unsupported") throw new HttpError(502, "users_unsupported");
    throw e;
  }
}

/** Ce que l'appli de l'instance propose (rôles, restrictions) et ses comptes reliés au Board. */
export async function appSchema(actor, instanceId, lang) {
  requireAdmin(actor);
  const inst = getInstance(instanceId);
  if (!inst) throw new HttpError(404, "not_found");
  return cleanUsersSchema(await callUsers(actor, inst, lang));
}

const userRow = (id) => db.prepare("SELECT id, email, name, role, lang FROM users WHERE id = ?").get(id);
const accessRow = (instanceId, userId) => db.prepare("SELECT * FROM access WHERE instance_id = ? AND user_id = ?").get(instanceId, userId);
const putBody = (u, row) => ({
  name: u.name, email: u.email, ...(u.lang ? { locale: u.lang } : {}), role: row.role, values: JSON.parse(row.settings || "{}"),
});
const errorOf = (e) => (e instanceof HttpError ? { code: e.code, ...(e.extra?.message ? { message: e.extra.message } : {}) } : { code: "server" });

function setSync(instanceId, userId, status, message) {
  db.prepare("UPDATE access SET sync_status = ?, sync_message = ?, synced_at = ? WHERE instance_id = ? AND user_id = ?")
    .run(status, message ? String(message).slice(0, 300) : null, Date.now(), instanceId, userId);
}
const syncMessage = (err) => JSON.stringify(err);

/* ---------- Lire ---------- */

function accessOut(row) {
  if (!row) return null;
  let sync = null;
  if (row.sync_status) {
    let detail = null;
    try { detail = row.sync_message ? JSON.parse(row.sync_message) : null; } catch { detail = { message: row.sync_message }; }
    sync = { status: row.sync_status, at: row.synced_at, ...(detail && typeof detail === "object" ? detail : {}) };
  }
  return {
    managed: row.role != null,
    role: row.role,
    label: row.role_label || row.role,
    admin: Boolean(row.role_admin),
    values: JSON.parse(row.settings || "{}"),
    revoked: Boolean(row.revoked),
    grantedAt: row.granted_at,
    sync,
  };
}

/** Toutes les instances, avec l'accès de la personne à chacune. */
export function userAccessList(userId) {
  return db.prepare(
    `SELECT i.id, i.app_id, i.name, i.base, i.path, i.client_id, a.*
       FROM instances i LEFT JOIN access a ON a.instance_id = i.id AND a.user_id = ?
      ORDER BY i.name COLLATE NOCASE`,
  ).all(userId).map((r) => ({
    space: { id: r.id, appId: r.app_id, name: r.name, base: r.base, path: r.path, sso: Boolean(r.client_id) },
    access: r.user_id ? accessOut(r) : null,
  }));
}

/** Les personnes qui ont accès à une instance. */
export function instanceAccessList(instanceId) {
  if (!getInstance(instanceId)) throw new HttpError(404, "not_found");
  return db.prepare(
    `SELECT u.id AS uid, u.name AS uname, u.email AS uemail, u.role AS urole, a.*
       FROM access a JOIN users u ON u.id = a.user_id WHERE a.instance_id = ? ORDER BY u.name COLLATE NOCASE`,
  ).all(instanceId).map((r) => ({ user: { id: r.uid, name: r.uname, email: r.uemail, role: r.urole }, access: accessOut(r) }));
}

const userOut = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, lang: u.lang ?? null, createdAt: u.created_at,
  pending: u.password_hash === "", totp: Boolean(u.totp_secret),
});

export function userDetail(actor, id) {
  requireAdmin(actor);
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!u) throw new HttpError(404, "not_found");
  return { user: userOut(u), spaces: userAccessList(id) };
}

/* ---------- Donner, changer, retirer un accès ---------- */

/**
 * Donne ou change l'accès de la personne `userId` à l'instance. `role` vide : accès non géré (rien n'est envoyé
 * à l'appli). Avec un rôle : le Board relit ce que l'appli propose, vérifie la forme, enregistre, puis envoie le PUT.
 * Si l'appli refuse, rien ne change ; si elle est injoignable, l'accès est gardé et marqué « à resynchroniser ».
 */
export async function setAccess(actor, instanceId, userId, body, lang) {
  requireAdmin(actor);
  const inst = getInstance(instanceId);
  if (!inst) throw new HttpError(404, "not_found");
  const target = userRow(userId);
  if (!target) throw new HttpError(404, "not_found");
  const before = accessRow(instanceId, userId);
  const now = Date.now();
  const role = body?.role == null || body.role === "" ? null : String(body.role);

  if (role === null) {
    db.prepare(
      `INSERT INTO access (instance_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET role = NULL, role_label = NULL, role_admin = 0, settings = NULL, revoked = 0,
         sync_status = NULL, sync_message = NULL, synced_at = NULL, granted_by = excluded.granted_by`,
    ).run(instanceId, userId, actor.id, now);
    return { access: accessOut(accessRow(instanceId, userId)), sync: null };
  }

  if (!ROLE.test(role)) throw bad("access_role");
  const schema = cleanUsersSchema(await callUsers(actor, inst, lang));
  const r = schema.roles.find((x) => x.value === role);
  if (!r) throw bad("access_role");
  const current = before?.settings ? JSON.parse(before.settings) : null;
  const values = cleanValues(schema, role, body.values, current);

  const save = db.prepare(
    `INSERT INTO access (instance_id, user_id, role, role_label, role_admin, settings, revoked, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT DO UPDATE SET role = excluded.role, role_label = excluded.role_label, role_admin = excluded.role_admin,
       settings = excluded.settings, revoked = 0, granted_by = excluded.granted_by`,
  );
  save.run(instanceId, userId, role, r.label, r.admin ? 1 : 0, JSON.stringify(values), actor.id, now);
  const row = accessRow(instanceId, userId);
  try {
    const out = await callUsers(actor, inst, lang, { method: "PUT", sub: userId, body: putBody(target, row) });
    const message = text(out?.message, 300);
    setSync(instanceId, userId, "ok", message ? syncMessage({ message }) : null);
    return { access: accessOut(accessRow(instanceId, userId)), sync: { ok: true, status: text(out?.status, 20) || null, message: message || null } };
  } catch (e) {
    if (e instanceof HttpError && REFUSED.has(e.code)) {
      // L'appli refuse : on revient à l'état d'avant.
      if (before) {
        db.prepare(
          `UPDATE access SET role = ?, role_label = ?, role_admin = ?, settings = ?, revoked = ?, granted_by = ?
            WHERE instance_id = ? AND user_id = ?`,
        ).run(before.role, before.role_label, before.role_admin, before.settings, before.revoked, before.granted_by, instanceId, userId);
      } else {
        db.prepare("DELETE FROM access WHERE instance_id = ? AND user_id = ?").run(instanceId, userId);
      }
      throw e;
    }
    const err = errorOf(e);
    setSync(instanceId, userId, "error", syncMessage(err));
    return { access: accessOut(accessRow(instanceId, userId)), sync: { ok: false, ...err } };
  }
}

/**
 * Retire l'accès. Accès géré : l'appli désactive d'abord le compte (DELETE). Si elle est injoignable,
 * l'accès est retiré du Board tout de suite (plus d'instance dans la liste, plus de connexion par le Board)
 * et la désactivation reste à refaire (« Resynchroniser »).
 */
export async function revokeAccess(actor, instanceId, userId, lang) {
  requireAdmin(actor);
  const inst = getInstance(instanceId);
  const row = inst && accessRow(instanceId, userId);
  if (!row) throw new HttpError(404, "not_found");
  if (row.role == null || !inst.client_id) {
    db.prepare("DELETE FROM access WHERE instance_id = ? AND user_id = ?").run(instanceId, userId);
    return { removed: true, sync: null };
  }
  db.prepare("UPDATE access SET revoked = 1 WHERE instance_id = ? AND user_id = ?").run(instanceId, userId);
  try {
    await callUsers(actor, inst, lang, { method: "DELETE", sub: userId });
    db.prepare("DELETE FROM access WHERE instance_id = ? AND user_id = ?").run(instanceId, userId);
    return { removed: true, sync: { ok: true } };
  } catch (e) {
    if (e instanceof HttpError && REFUSED.has(e.code)) {
      db.prepare("UPDATE access SET revoked = ? WHERE instance_id = ? AND user_id = ?").run(row.revoked, instanceId, userId);
      throw e;
    }
    const err = errorOf(e);
    setSync(instanceId, userId, "error", syncMessage(err));
    return { removed: false, access: accessOut(accessRow(instanceId, userId)), sync: { ok: false, ...err } };
  }
}

/** Renvoie à l'appli l'état retenu par le Board : le dernier PUT, ou la désactivation restée en attente. */
export async function resyncAccess(actor, instanceId, userId, lang) {
  requireAdmin(actor);
  const inst = getInstance(instanceId);
  const row = inst && accessRow(instanceId, userId);
  if (!row) throw new HttpError(404, "not_found");
  if (row.role == null) return { access: accessOut(row), sync: null };
  if (row.revoked) return revokeAccess(actor, instanceId, userId, lang);
  const target = userRow(userId);
  try {
    const out = await callUsers(actor, inst, lang, { method: "PUT", sub: userId, body: putBody(target, row) });
    const message = text(out?.message, 300);
    setSync(instanceId, userId, "ok", message ? syncMessage({ message }) : null);
    return { access: accessOut(accessRow(instanceId, userId)), sync: { ok: true, message: message || null } };
  } catch (e) {
    const err = errorOf(e);
    setSync(instanceId, userId, "error", syncMessage(err));
    return { access: accessOut(accessRow(instanceId, userId)), sync: { ok: false, ...err } };
  }
}

/**
 * Le nom ou l'e-mail d'une personne a changé : ses comptes gérés sont mis à jour, en arrière-plan, au nom de
 * l'administrateur qui a donné chaque accès (c'est lui qui est administrateur de l'appli).
 */
export function syncUserEverywhere(userId, lang = "fr") {
  const rows = db.prepare(
    `SELECT a.instance_id, a.granted_by FROM access a JOIN instances i ON i.id = a.instance_id
      WHERE a.user_id = ? AND a.role IS NOT NULL AND a.revoked = 0 AND i.client_id IS NOT NULL`,
  ).all(userId);
  return Promise.all(rows.map(async (r) => {
    const actor = r.granted_by && db.prepare("SELECT id, email, name, role, lang FROM users WHERE id = ? AND role = 'admin'").get(r.granted_by);
    if (!actor) return;
    try {
      await resyncAccess(actor, r.instance_id, userId, lang);
    } catch { /* marqué « à resynchroniser » par resyncAccess quand c'est possible */ }
  }));
}

/* ---------- Comptes du Board ---------- */

function cleanEmail(v) {
  const e = str(v, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw bad("email");
  return e;
}
function cleanName(v) {
  const n = str(v, 80);
  if (!n) throw bad("name");
  return n;
}

/** Lien à usage unique pour choisir son mot de passe (activation d'un compte créé par un administrateur, ou oubli). */
function newPasswordLink(actorId, userId) {
  const raw = token(24);
  const now = Date.now();
  tx(() => {
    db.prepare("DELETE FROM password_links WHERE user_id = ?").run(userId);
    db.prepare("INSERT INTO password_links (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(raw), userId, actorId, now, now + LINK_DAYS * DAY);
  });
  return { url: `${config.publicUrl}/#/activation/${raw}`, expiresAt: now + LINK_DAYS * DAY };
}

/** Crée un compte du Board, sans mot de passe : la personne le choisit par le lien renvoyé (montré une fois). */
export function createUser(actor, body) {
  requireAdmin(actor);
  const name = cleanName(body?.name), email = cleanEmail(body?.email);
  const role = body?.role === "admin" ? "admin" : "member";
  const lang = body?.lang === "fr" || body?.lang === "en" ? body.lang : null;
  const id = newUserId();
  tx(() => {
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "email_taken");
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, lang, created_at) VALUES (?, ?, ?, '', ?, ?, ?)")
      .run(id, email, name, role, lang, Date.now());
  });
  return { user: userOut(db.prepare("SELECT * FROM users WHERE id = ?").get(id)), link: newPasswordLink(actor.id, id) };
}

/** Nom, e-mail, rôle dans le Board. On ne change pas son propre rôle (il pourrait ne plus rester d'administrateur). */
export function updateUser(actor, id, body) {
  requireAdmin(actor);
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!u) throw new HttpError(404, "not_found");
  const name = "name" in (body ?? {}) ? cleanName(body.name) : u.name;
  const email = "email" in (body ?? {}) ? cleanEmail(body.email) : u.email;
  const role = body?.role === "admin" || body?.role === "member" ? body.role : u.role;
  if (id === actor.id && role !== u.role) throw bad("self");
  if (email !== u.email && db.prepare("SELECT 1 FROM users WHERE email = ? AND id <> ?").get(email, id)) throw new HttpError(409, "email_taken");
  db.prepare("UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?").run(name, email, role, id);
  if (name !== u.name || email !== u.email) syncUserEverywhere(id, actor.lang ?? "fr");
  return userDetail(actor, id);
}

export function passwordLink(actor, id) {
  requireAdmin(actor);
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) throw new HttpError(404, "not_found");
  return newPasswordLink(actor.id, id);
}

const findLink = (raw) =>
  typeof raw === "string" && raw.length < 100
    ? db.prepare(
      `SELECT l.*, u.name, u.email, u.password_hash = '' AS pending FROM password_links l JOIN users u ON u.id = l.user_id
        WHERE l.token_hash = ? AND l.expires_at > ?`,
    ).get(sha256(raw), Date.now())
    : undefined;

export function checkPasswordLink(raw) {
  const l = findLink(raw);
  return l ? { valid: true, name: l.name, email: l.email, activation: Boolean(l.pending) } : { valid: false };
}

/** Choisit le mot de passe : le lien ne sert qu'une fois, et les sessions ouvertes du compte sont fermées. Renvoie l'id. */
export async function acceptPasswordLink(raw, password) {
  const l = findLink(raw);
  if (!l) throw new HttpError(410, "link_invalid");
  checkPassword(password);
  const hash = await hashPassword(password);
  tx(() => {
    if (!db.prepare("DELETE FROM password_links WHERE token_hash = ?").run(l.token_hash).changes) throw new HttpError(410, "link_invalid");
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, l.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(l.user_id);
  });
  return l.user_id;
}

/**
 * Supprime un compte du Board. Ses comptes gérés dans les applis sont d'abord désactivés ; une appli injoignable
 * est signalée (le compte de l'appli n'a pas de mot de passe : sans le Board, personne ne peut plus y entrer).
 */
export async function removeUser(actor, id, lang) {
  requireAdmin(actor);
  if (id === actor.id) throw bad("self");
  if (!userRow(id)) throw new HttpError(404, "not_found");
  const rows = db.prepare(
    `SELECT i.* FROM access a JOIN instances i ON i.id = a.instance_id
      WHERE a.user_id = ? AND a.role IS NOT NULL AND i.client_id IS NOT NULL`,
  ).all(id);
  const warnings = [];
  for (const inst of rows) {
    try {
      await callUsers(actor, inst, lang, { method: "DELETE", sub: id });
    } catch (e) {
      warnings.push({ space: inst.name, ...errorOf(e) });
    }
  }
  removeMember(actor, id);
  return { ok: true, warnings };
}

export { listMembers };

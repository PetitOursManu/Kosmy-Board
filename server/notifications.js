/*
 * Notifications : une appli reliée au Board par la connexion unique (Soundy, Kanby…) envoie une notification,
 * le Board la garde pour chaque personne concernée, et on la lit dans le Board (cloche) ou dans Kosmy Mobile.
 *
 * L'appli s'authentifie avec l'identifiant et le secret client de sa connexion unique (en-tête Basic).
 * Destinataires : les personnes qui ont, dans leur Board, un espace relié à ce client — éventuellement réduites
 * à la liste « to » (des « sub » de l'ID token, c'est-à-dire des identifiants de compte du Board).
 * Voir docs/notifications.md.
 */
import { timingSafeEqual } from "node:crypto";

import { db, tx } from "./db.js";
import { bad, HttpError } from "./http.js";

/** Notifications gardées par personne (les plus anciennes partent). */
export const KEEP_PER_USER = 200;
/** Par client : 30 envois par minute au plus. */
const RATE_MAX = 30;
const RATE_WINDOW = 60_000;
const rate = new Map(); // client_id → { start, count }

const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** « Authorization: Basic … » (client_secret_basic : identifiant et secret encodés en URL, puis en base64). */
export function clientFromBasic(header) {
  const m = /^Basic ([A-Za-z0-9+/=]{4,600})$/.exec(String(header ?? "").trim());
  if (!m) return null;
  const raw = Buffer.from(m[1], "base64").toString("utf8");
  const i = raw.indexOf(":");
  if (i < 1) return null;
  let id, secret;
  // Encodage « application/x-www-form-urlencoded » (RFC 6749 § 2.3.1) : « + » vaut une espace.
  const dec = (x) => decodeURIComponent(x.replace(/\+/g, " "));
  try {
    id = dec(raw.slice(0, i));
    secret = dec(raw.slice(i + 1));
  } catch {
    return null;
  }
  const row = db.prepare("SELECT * FROM sso_clients WHERE client_id = ?").get(id);
  // Comparaison à temps constant, même quand le client n'existe pas.
  const want = Buffer.from(row?.secret ?? "x".repeat(43));
  const got = Buffer.from(secret);
  const ok = got.length === want.length && timingSafeEqual(got, want);
  return row && ok ? row : null;
}

function checkRate(clientId, now = Date.now()) {
  const r = rate.get(clientId);
  if (!r || now - r.start > RATE_WINDOW) {
    rate.set(clientId, { start: now, count: 1 });
    if (rate.size > 1000) for (const [k, v] of rate) if (now - v.start > RATE_WINDOW) rate.delete(k);
    return;
  }
  if (++r.count > RATE_MAX) throw new HttpError(429, "rate_limited", { wait: Math.ceil((r.start + RATE_WINDOW - now) / 1000) });
}

/** Lien de la notification : une page de l'instance elle-même (même origine que son adresse), sinon rien. */
function cleanLink(v, base) {
  const raw = str(v, 1000);
  if (!raw) return null;
  try {
    const u = new URL(raw, `${base}/`);
    if (u.origin !== new URL(base).origin || u.username || u.password) throw new Error();
    return u.href;
  } catch {
    throw bad("url");
  }
}

/** Enregistre une notification d'un client pour ses destinataires. Renvoie le nombre de personnes. */
export function notifyFromClient(client, body, now = Date.now()) {
  const title = str(body.title, 120);
  if (!title) throw bad("title");
  const text = str(body.body, 1000) || null;
  const url = cleanLink(body.url, client.base);
  let users = db.prepare("SELECT DISTINCT user_id FROM spaces WHERE client_id = ?").all(client.client_id).map((r) => r.user_id);
  if (body.to !== undefined) {
    if (!Array.isArray(body.to) || body.to.length > 500) throw bad("to");
    const to = new Set(body.to.filter((x) => typeof x === "string"));
    users = users.filter((u) => to.has(u));
  }
  checkRate(client.client_id, now);
  if (!users.length) return 0;
  const insert = db.prepare(
    "INSERT INTO notifications (user_id, client_id, app_name, app_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const prune = db.prepare(
    `DELETE FROM notifications WHERE user_id = ? AND id NOT IN
       (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ${KEEP_PER_USER})`,
  );
  tx(() => {
    for (const u of users) {
      insert.run(u, client.client_id, client.name, client.app_id, title, text, url, now);
      prune.run(u, u);
    }
  });
  return users.length;
}

/* ---------- Lecture (Board et Kosmy Mobile) ---------- */

const out = (r) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  url: r.url,
  createdAt: r.created_at,
  read: r.read_at !== null,
  app: { name: r.app_name, appId: r.app_id, spaceId: r.space_id ?? null },
});

export const unreadCount = (userId) =>
  db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId).n;

/** Les plus récentes d'abord ; « after » : seulement celles plus récentes que cet identifiant (Kosmy Mobile). */
export function listNotifications(userId, { after = 0, limit = 50 } = {}) {
  const rows = db.prepare(
    `SELECT n.*, (SELECT s.id FROM spaces s WHERE s.user_id = n.user_id AND s.client_id = n.client_id LIMIT 1) AS space_id
       FROM notifications n WHERE n.user_id = ? AND n.id > ? ORDER BY n.id DESC LIMIT ?`,
  ).all(userId, after, limit);
  return { notifications: rows.map(out), unread: unreadCount(userId) };
}

/** Marque comme lues (toutes, ou la liste d'identifiants). */
export function markRead(userId, ids, now = Date.now()) {
  if (ids === undefined) {
    db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(now, userId);
    return;
  }
  if (!Array.isArray(ids) || ids.length > 500) throw bad("ids");
  const upd = db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL");
  tx(() => ids.filter(Number.isSafeInteger).forEach((id) => upd.run(now, userId, id)));
}

export function deleteNotifications(userId, id) {
  if (id === undefined) db.prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
  else if (!db.prepare("DELETE FROM notifications WHERE user_id = ? AND id = ?").run(userId, id).changes) throw new HttpError(404, "not_found");
}

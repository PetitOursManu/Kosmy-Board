/* Comptes et sessions du Board. Les mots de passe sont hachés (scrypt) ; les jetons de session ne sont stockés que hachés. */
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { config } from "./config.js";
import { db } from "./db.js";
import { HttpError, parseCookies } from "./http.js";

const scrypt = promisify(scryptCb);
const N = 32768, R = 8, P = 1, KEYLEN = 32, MAXMEM = 96 * 1024 * 1024;
const DAY = 86_400_000;

export const COOKIE = config.secure ? "__Host-kb_session" : "kb_session";
export const PASSWORD_MIN = 10;

export const sha256 = (s) => createHash("sha256").update(s).digest("base64url");
export const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const newUserId = () => randomUUID();

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = await scrypt(pw.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${h.toString("base64url")}`;
}

export async function verifyPassword(pw, stored) {
  const [kind, n, r, p, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64url");
  const got = await scrypt(pw.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return timingSafeEqual(got, expected);
}

/** Haché factice : un e-mail inconnu prend autant de temps qu'un mauvais mot de passe. */
let dummyHash = null;
export async function dummyVerify(pw) {
  dummyHash ??= await hashPassword("kosmy-board-dummy-password");
  await verifyPassword(pw, dummyHash);
  return false;
}

export function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < PASSWORD_MIN) throw new HttpError(400, "password_short", { min: PASSWORD_MIN });
  if (pw.length > 200) throw new HttpError(400, "password_long");
}

/* ---------- Sessions ---------- */

export function createSession(res, userId) {
  const raw = token();
  const now = Date.now();
  db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, seen_at) VALUES (?, ?, ?, ?, ?)")
    .run(sha256(raw), userId, now, now + config.sessionDays * DAY, now);
  setCookie(res, raw, config.sessionDays * 86_400);
}

/**
 * Connexion d'un appareil (Kosmy Mobile) : un jeton renvoyé dans la réponse, jamais dans un cookie.
 * L'appareil le garde et l'envoie dans « Authorization: Bearer ». Seul son haché est conservé.
 */
export function createDeviceToken(userId, device) {
  const raw = token();
  const now = Date.now();
  db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, seen_at, device) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sha256(raw), userId, now, now + config.deviceDays * DAY, now, device);
  return raw;
}

export function setCookie(res, value, maxAge) {
  const parts = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (config.secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

/** La requête porte un en-tête Authorization (appareil) : les cookies sont alors ignorés. */
export const hasAuthorization = (req) => typeof req.headers.authorization === "string";

/** Jeton de la requête : « Authorization: Bearer … » pour un appareil, sinon le cookie du navigateur. */
function sessionToken(req) {
  if (hasAuthorization(req)) {
    const m = /^Bearer ([\w-]{20,100})$/.exec(req.headers.authorization.trim());
    return m ? { raw: m[1], device: true } : null;
  }
  const raw = parseCookies(req)[COOKIE];
  return raw && raw.length <= 100 ? { raw, device: false } : null;
}

/** Utilisateur connecté, ou null. Prolonge la session au plus une fois par jour. */
export function currentUser(req) {
  const tok = sessionToken(req);
  if (!tok) return null;
  const idHash = sha256(tok.raw);
  const row = db.prepare(
    `SELECT s.expires_at, s.seen_at, s.device, u.id, u.email, u.name, u.role, u.lang, u.totp_secret IS NOT NULL AS totp
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
  ).get(idHash);
  // Un jeton d'appareil ne vaut pas cookie, et inversement.
  if (!row || (row.device !== null) !== tok.device) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
    return null;
  }
  if (now - row.seen_at > DAY) {
    const days = tok.device ? config.deviceDays : config.sessionDays;
    db.prepare("UPDATE sessions SET seen_at = ?, expires_at = ? WHERE id_hash = ?").run(now, now + days * DAY, idHash);
  }
  return {
    id: row.id, email: row.email, name: row.name, role: row.role, lang: row.lang, totp: Boolean(row.totp),
    sessionHash: idHash, device: row.device,
  };
}

export function destroySession(req, res) {
  const tok = sessionToken(req);
  if (tok) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(tok.raw));
  if (!tok?.device) setCookie(res, "", 0);
}

export function purgeExpired() {
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM invites WHERE expires_at < ?").run(now);
}

/* ---------- Tentatives de connexion ---------- */

const FAIL_WINDOW = 15 * 60_000;
/**
 * 5 échecs par compte (ou par code d'invitation, de configuration…), 30 par adresse IP :
 * derrière un reverse proxy ou un même réseau, beaucoup de personnes partagent une IP,
 * et un inconnu ne doit pas pouvoir bloquer la connexion de tout le monde.
 */
const limitFor = (key) => (key.startsWith("ip:") ? 30 : 5);
const failures = new Map();

/** Trop d'échecs pour cette adresse IP ou ce compte : on bloque 15 minutes. Renvoie les secondes restantes. */
export function lockedFor(keys) {
  const now = Date.now();
  let wait = 0;
  for (const k of keys) {
    const f = failures.get(k);
    if (!f) continue;
    if (now - f.first > FAIL_WINDOW) failures.delete(k);
    else if (f.count >= limitFor(k)) wait = Math.max(wait, Math.ceil((f.first + FAIL_WINDOW - now) / 1000));
  }
  return wait;
}
export function recordFailure(keys) {
  const now = Date.now();
  for (const k of keys) {
    const f = failures.get(k);
    if (!f || now - f.first > FAIL_WINDOW) failures.set(k, { first: now, count: 1 });
    else f.count++;
  }
  if (failures.size > 10_000) failures.clear();
}
export const clearFailures = (keys) => keys.forEach((k) => failures.delete(k));

/* ---------- Première configuration ---------- */

let setupCode = null;
/** Tant qu'aucun compte n'existe, un code à usage unique (affiché dans les journaux du serveur) protège la création du premier compte. */
export function needsSetup() {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0;
}
export function ensureSetupCode() {
  if (!needsSetup()) return null;
  if (!setupCode) {
    const raw = randomBytes(6).toString("hex").toUpperCase();
    setupCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  }
  return setupCode;
}
export function checkSetupCode(code) {
  const expected = ensureSetupCode();
  if (!expected) return false;
  const a = Buffer.from(String(code ?? "").trim().toUpperCase());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function consumeSetupCode() {
  setupCode = null;
}

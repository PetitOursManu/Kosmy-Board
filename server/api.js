/* Routes /api du Board. Toutes répondent en JSON. */
import { randomBytes } from "node:crypto";

import QRCode from "qrcode";

import { isLocalHost, normalizeBase, normalizePath } from "../public/js/normalize.js";
import {
  checkPassword, checkSetupCode, clearFailures, consumeSetupCode, createDeviceToken, createSession, currentUser, destroySession,
  dummyVerify, hasAuthorization, hashPassword, lockedFor, needsSetup, newUserId, recordFailure, sha256, token, verifyPassword,
} from "./auth.js";
import { config } from "./config.js";
import { db, tx } from "./db.js";
import { bad, clientIp, HttpError, readJson, sameOrigin, send } from "./http.js";
import { callApp, cleanActionInput, cleanManifest, cleanResult, cleanSection, SECTION_ID } from "./admin.js";
import { ISSUER, provider } from "./oidc.js";
import { newRecoveryCodes, newTotpSecret, normalizeRecovery, otpauthUri, verifyTotp } from "./totp.js";

const DAY = 86_400_000;
const INVITE_DAYS = 7;
const MAX_SPACES = 500;
const LANGS = new Set(["fr", "en"]);

/* ---------- Validation ---------- */

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

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
const cleanLang = (v) => (LANGS.has(v) ? v : null);

/** Un espace reçu de l'interface ou d'un fichier importé. */
function cleanSpace(raw) {
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
const spaceOut = (r, withSso = true) => ({
  id: r.id, appId: r.app_id, name: r.name, base: r.base, path: r.path, addedAt: r.added_at,
  ...(r.opened_at ? { openedAt: r.opened_at } : {}),
  ...(withSso && r.client_id ? { sso: { loginUri: r.initiate_login_uri ?? null } } : {}),
});
const SPACE_SELECT = "SELECT s.*, c.initiate_login_uri FROM spaces s LEFT JOIN sso_clients c ON c.client_id = s.client_id";
const getSpace = (userId, id) => db.prepare(`${SPACE_SELECT} WHERE s.user_id = ? AND s.id = ?`).get(userId, id);
const userOut = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, lang: u.lang ?? null,
  totp: Boolean(u.totp ?? u.totp_secret),
});
const newSpaceId = () => `${Date.now().toString(36)}${randomBytes(4).toString("hex").slice(0, 5)}`;

/* ---------- Routes ---------- */

const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

route("GET", /^\/api\/state$/, (req, res) => {
  const user = currentUser(req);
  send(res, 200, {
    setupNeeded: needsSetup(),
    user: user ? userOut(user) : null,
    config: { kosmyUrl: config.kosmyUrl, catalogUrl: config.catalogUrl, publicUrl: config.publicUrl, issuer: ISSUER },
  });
}, { auth: false });

/* Première configuration : crée le compte administrateur. */
route("POST", /^\/api\/setup$/, async (req, res) => {
  const body = await readJson(req);
  const ip = clientIp(req);
  const wait = lockedFor([`setup:${ip}`]);
  if (wait) throw new HttpError(429, "locked", { wait });
  if (!needsSetup()) throw new HttpError(409, "already_setup");
  if (!checkSetupCode(body.code)) {
    recordFailure([`setup:${ip}`]);
    throw bad("setup_code");
  }
  const name = cleanName(body.name), email = cleanEmail(body.email);
  checkPassword(body.password);
  const hash = await hashPassword(body.password);
  const id = newUserId();
  tx(() => {
    if (!needsSetup()) throw new HttpError(409, "already_setup");
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, lang, created_at) VALUES (?, ?, ?, ?, 'admin', ?, ?)")
      .run(id, email, name, hash, cleanLang(body.lang), Date.now());
  });
  consumeSetupCode();
  createSession(res, id);
  send(res, 201, { ok: true });
}, { auth: false });

/** E-mail et mot de passe vérifiés : renvoie l'identifiant du compte et s'il faut encore le second facteur. */
async function passwordStep(req, body) {
  const email = str(body.email, 200).toLowerCase();
  const password = typeof body.password === "string" ? body.password.slice(0, 200) : "";
  const keys = [`ip:${clientIp(req)}`, `user:${email}`];
  const wait = lockedFor(keys);
  if (wait) throw new HttpError(429, "locked", { wait });
  const user = email ? db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email) : null;
  const ok = user ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);
  if (!ok) {
    recordFailure(keys);
    throw new HttpError(401, "login_failed");
  }
  clearFailures(keys);
  return { userId: user.id, twoFactor: Boolean(db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(user.id).totp_secret) };
}

/** Le code de double authentification, pour un ticket donné après le mot de passe. Renvoie le ticket. */
function secondFactorStep(body, device) {
  const key = String(body.ticket ?? "");
  const ticket = tickets.get(key);
  // Un ticket du navigateur ne donne pas de jeton d'appareil, et inversement.
  if (!ticket || ticket.exp < Date.now() || ticket.attempts >= 5 || (ticket.device !== null) !== device) {
    tickets.delete(key);
    throw new HttpError(401, "ticket");
  }
  const keys = [`2fa:${ticket.userId}`];
  const wait = lockedFor(keys);
  if (wait) throw new HttpError(429, "locked", { wait });
  ticket.attempts++;
  if (!checkSecondFactor(ticket.userId, body.code)) {
    recordFailure(keys);
    throw bad("code");
  }
  tickets.delete(key);
  clearFailures(keys);
  return ticket;
}

route("POST", /^\/api\/login$/, async (req, res) => {
  const { userId, twoFactor } = await passwordStep(req, await readJson(req));
  if (twoFactor) {
    // Mot de passe correct, mais il faut encore le code de l'application d'authentification.
    send(res, 200, { twoFactor: true, ticket: newTicket(userId) });
    return;
  }
  createSession(res, userId);
  send(res, 200, { ok: true });
}, { auth: false });

route("POST", /^\/api\/login\/2fa$/, async (req, res) => {
  const ticket = secondFactorStep(await readJson(req), false);
  createSession(res, ticket.userId);
  send(res, 200, { ok: true });
}, { auth: false });

/* ---------- Appareils (Kosmy Mobile) ---------- */

/*
 * Connexion d'un appareil : le jeton est renvoyé dans la réponse (aucun cookie). Ces deux routes ne vérifient pas
 * l'origine : une appli mobile n'en envoie pas, et une page d'un autre site ne pourrait pas lire la réponse.
 */
const cleanDevice = (v) => str(v, 60).replace(/[\u0000-\u001f\u007f]/g, "") || "Kosmy Mobile";
const deviceOut = (userId, tok) => ({ token: tok, user: userOut(db.prepare("SELECT * FROM users WHERE id = ?").get(userId)) });

route("POST", /^\/api\/device\/login$/, async (req, res) => {
  const body = await readJson(req);
  const { userId, twoFactor } = await passwordStep(req, body);
  const device = cleanDevice(body.device);
  if (twoFactor) {
    send(res, 200, { twoFactor: true, ticket: newTicket(userId, device) });
    return;
  }
  send(res, 200, deviceOut(userId, createDeviceToken(userId, device)));
}, { auth: false, csrf: false });

route("POST", /^\/api\/device\/login\/2fa$/, async (req, res) => {
  const ticket = secondFactorStep(await readJson(req), true);
  send(res, 200, deviceOut(ticket.userId, createDeviceToken(ticket.userId, ticket.device)));
}, { auth: false, csrf: false });

/* Les appareils connectés au compte, pour les déconnecter depuis le Board. */
route("GET", /^\/api\/devices$/, (req, res, user) => {
  const rows = db.prepare("SELECT id_hash, device, created_at, seen_at FROM sessions WHERE user_id = ? AND device IS NOT NULL ORDER BY seen_at DESC")
    .all(user.id);
  send(res, 200, {
    devices: rows.map((r) => ({
      id: r.id_hash, name: r.device, createdAt: r.created_at, seenAt: r.seen_at, current: r.id_hash === user.sessionHash,
    })),
  });
});

route("DELETE", /^\/api\/devices\/([\w-]{20,64})$/, (req, res, user, [id]) => {
  const r = db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash = ? AND device IS NOT NULL").run(user.id, id);
  if (!r.changes) throw new HttpError(404, "not_found");
  send(res, 200, { ok: true });
});

route("POST", /^\/api\/logout$/, (req, res) => {
  destroySession(req, res);
  send(res, 200, { ok: true });
}, { auth: false });

route("PATCH", /^\/api\/me$/, async (req, res, user) => {
  const body = await readJson(req);
  if ("lang" in body) db.prepare("UPDATE users SET lang = ? WHERE id = ?").run(cleanLang(body.lang), user.id);
  if ("name" in body) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(cleanName(body.name), user.id);
  send(res, 200, { user: userOut(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) });
});

/* Changer de mot de passe : les autres sessions de ce compte sont fermées. */
route("POST", /^\/api\/password$/, async (req, res, user) => {
  const body = await readJson(req);
  const keys = [`pw:${user.id}`];
  const wait = lockedFor(keys);
  if (wait) throw new HttpError(429, "locked", { wait });
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
  if (!(await verifyPassword(String(body.current ?? "").slice(0, 200), row.password_hash))) {
    recordFailure(keys);
    throw bad("current_password");
  }
  checkPassword(body.next);
  const hash = await hashPassword(body.next);
  tx(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?").run(user.id, user.sessionHash);
  });
  send(res, 200, { ok: true });
});

/* ---------- Espaces ---------- */

route("GET", /^\/api\/spaces$/, (req, res, user) => {
  const rows = db.prepare(`${SPACE_SELECT} WHERE s.user_id = ? ORDER BY COALESCE(s.opened_at, s.added_at) DESC`).all(user.id);
  send(res, 200, { spaces: rows.map((r) => spaceOut(r)) });
});

route("POST", /^\/api\/spaces$/, async (req, res, user) => {
  const s = cleanSpace(await readJson(req));
  if (db.prepare("SELECT COUNT(*) AS n FROM spaces WHERE user_id = ?").get(user.id).n >= MAX_SPACES) throw bad("too_many");
  const row = { id: newSpaceId(), added_at: Date.now() };
  db.prepare("INSERT INTO spaces (user_id, id, app_id, name, base, path, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(user.id, row.id, s.appId, s.name, s.base, s.path, row.added_at);
  send(res, 201, { space: spaceOut(getSpace(user.id, row.id)) });
});

route("PUT", /^\/api\/spaces\/([\w-]{1,40})$/, async (req, res, user, [id]) => {
  const s = cleanSpace(await readJson(req));
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
  send(res, 200, { space: spaceOut(getSpace(user.id, id)) });
});

route("DELETE", /^\/api\/spaces\/([\w-]{1,40})$/, (req, res, user, [id]) => {
  const old = getSpace(user.id, id);
  if (!old) throw new HttpError(404, "not_found");
  tx(() => {
    db.prepare("DELETE FROM spaces WHERE user_id = ? AND id = ?").run(user.id, id);
    if (old.client_id) dropOrphanClient(old.client_id);
  });
  send(res, 200, { ok: true });
});

route("POST", /^\/api\/spaces\/([\w-]{1,40})\/opened$/, (req, res, user, [id]) => {
  const now = Date.now();
  const r = db.prepare("UPDATE spaces SET opened_at = ? WHERE user_id = ? AND id = ?").run(now, user.id, id);
  if (!r.changes) throw new HttpError(404, "not_found");
  send(res, 200, { openedAt: now });
});

/* Export : un tableau d'AdminSpace, le même format que Kosmy Mobile, avec un en-tête pour le reconnaître. */
route("GET", /^\/api\/spaces\/export$/, (req, res, user) => {
  const rows = db.prepare("SELECT * FROM spaces WHERE user_id = ? ORDER BY added_at").all(user.id);
  const date = new Date().toISOString().slice(0, 10);
  send(res, 200, { format: "kosmy.admin.v1", exportedAt: new Date().toISOString(), spaces: rows.map((r) => spaceOut(r, false)) }, {
    "Content-Disposition": `attachment; filename="kosmy-board-${date}.json"`,
  });
});

/* Import : accepte l'export du Board ou un simple tableau d'AdminSpace (Kosmy Mobile). Les doublons sont ignorés. */
route("POST", /^\/api\/spaces\/import$/, async (req, res, user) => {
  const body = await readJson(req, 2_000_000);
  const list = Array.isArray(body) ? body : Array.isArray(body.spaces) ? body.spaces : null;
  if (!list) throw bad("import_format");
  let added = 0, skipped = 0, invalid = 0;
  tx(() => {
    const existing = db.prepare("SELECT id, base, path FROM spaces WHERE user_id = ?").all(user.id);
    const ids = new Set(existing.map((s) => s.id));
    const urls = new Set(existing.map((s) => `${s.base}${s.path}`));
    const insert = db.prepare(
      "INSERT INTO spaces (user_id, id, app_id, name, base, path, added_at, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const raw of list.slice(0, MAX_SPACES)) {
      let s;
      try {
        s = cleanSpace(raw);
      } catch {
        invalid++;
        continue;
      }
      if (urls.has(`${s.base}${s.path}`)) {
        skipped++;
        continue;
      }
      if (ids.size >= MAX_SPACES) break;
      let id = typeof raw.id === "string" && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : newSpaceId();
      while (ids.has(id)) id = newSpaceId();
      const num = (v) => (Number.isFinite(v) && v > 0 && v < 1e13 ? Math.round(v) : null);
      insert.run(user.id, id, s.appId, s.name, s.base, s.path, num(raw.addedAt) ?? Date.now(), num(raw.openedAt));
      ids.add(id);
      urls.add(`${s.base}${s.path}`);
      added++;
    }
  });
  send(res, 200, { added, skipped, invalid });
});

/* ---------- Membres et invitations (administrateurs) ---------- */

route("GET", /^\/api\/users$/, (req, res) => {
  const users = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.created_at, (SELECT COUNT(*) FROM spaces s WHERE s.user_id = u.id) AS spaces
       FROM users u ORDER BY u.created_at`,
  ).all();
  const invites = db.prepare("SELECT id, role, created_at, expires_at FROM invites WHERE expires_at > ? ORDER BY created_at DESC")
    .all(Date.now());
  send(res, 200, {
    users: users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, spaces: u.spaces })),
    invites: invites.map((i) => ({ id: i.id, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at })),
  });
}, { admin: true });

/* Le lien n'est montré qu'une fois : seul son haché est conservé. */
route("POST", /^\/api\/invites$/, async (req, res, user) => {
  const body = await readJson(req);
  const role = body.role === "admin" ? "admin" : "member";
  const raw = token(24);
  const id = newSpaceId();
  const now = Date.now();
  db.prepare("INSERT INTO invites (id, token_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, sha256(raw), role, user.id, now, now + INVITE_DAYS * DAY);
  send(res, 201, { id, url: `${config.publicUrl}/#/invitation/${raw}`, expiresAt: now + INVITE_DAYS * DAY });
}, { admin: true });

route("DELETE", /^\/api\/invites\/([\w-]{1,40})$/, (req, res, user, [id]) => {
  db.prepare("DELETE FROM invites WHERE id = ?").run(id);
  send(res, 200, { ok: true });
}, { admin: true });

route("DELETE", /^\/api\/users\/([\w-]{1,40})$/, (req, res, user, [id]) => {
  if (id === user.id) throw bad("self");
  const clients = db.prepare("SELECT DISTINCT client_id FROM spaces WHERE user_id = ? AND client_id IS NOT NULL").all(id);
  tx(() => {
    const r = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    if (!r.changes) throw new HttpError(404, "not_found");
    // Ses sessions et autorisations de connexion unique disparaissent avec lui.
    db.prepare("DELETE FROM oidc_store WHERE json_extract(payload, '$.accountId') = ?").run(id);
    for (const c of clients) dropOrphanClient(c.client_id);
  });
  send(res, 200, { ok: true });
}, { admin: true });

const findInvite = (raw) =>
  typeof raw === "string" && raw.length < 100
    ? db.prepare("SELECT * FROM invites WHERE token_hash = ? AND expires_at > ?").get(sha256(raw), Date.now())
    : undefined;

route("POST", /^\/api\/invites\/check$/, async (req, res) => {
  const body = await readJson(req);
  send(res, 200, { valid: Boolean(findInvite(body.token)) });
}, { auth: false });

route("POST", /^\/api\/invites\/accept$/, async (req, res) => {
  const body = await readJson(req);
  const ip = clientIp(req);
  const wait = lockedFor([`invite:${ip}`]);
  if (wait) throw new HttpError(429, "locked", { wait });
  const invite = findInvite(body.token);
  if (!invite) {
    recordFailure([`invite:${ip}`]);
    throw new HttpError(410, "invite_invalid");
  }
  const name = cleanName(body.name), email = cleanEmail(body.email);
  checkPassword(body.password);
  const hash = await hashPassword(body.password);
  const id = newUserId();
  tx(() => {
    if (!db.prepare("DELETE FROM invites WHERE id = ?").run(invite.id).changes) throw new HttpError(410, "invite_invalid");
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "email_taken");
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, email, name, hash, invite.role, cleanLang(body.lang), Date.now());
  });
  createSession(res, id);
  send(res, 201, { ok: true });
}, { auth: false });

/* ---------- Double authentification ---------- */

const tickets = new Map(); // ticket → { userId, device, exp, attempts } : 5 minutes entre le mot de passe et le code
function newTicket(userId, device = null) {
  const t = token(24);
  tickets.set(t, { userId, device, exp: Date.now() + 5 * 60_000, attempts: 0 });
  if (tickets.size > 1000) for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
  return t;
}

/** Code de l'application (TOTP), ou code de secours (utilisable une seule fois). */
function checkSecondFactor(userId, code) {
  const row = db.prepare("SELECT totp_secret, totp_last_step, recovery_codes FROM users WHERE id = ?").get(userId);
  if (!row?.totp_secret) return false;
  const step = verifyTotp(row.totp_secret, code, row.totp_last_step);
  if (step !== null) {
    db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ?").run(step, userId);
    return true;
  }
  const rc = normalizeRecovery(code);
  if (rc.length !== 8) return false;
  const hashes = JSON.parse(row.recovery_codes || "[]");
  const h = sha256(rc);
  if (!hashes.includes(h)) return false;
  db.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?").run(JSON.stringify(hashes.filter((x) => x !== h)), userId);
  return true;
}

function freshRecoveryCodes() {
  const codes = newRecoveryCodes();
  return { codes, hashes: JSON.stringify(codes.map((c) => sha256(normalizeRecovery(c)))) };
}

route("GET", /^\/api\/2fa$/, (req, res, user) => {
  const row = db.prepare("SELECT totp_secret, recovery_codes FROM users WHERE id = ?").get(user.id);
  send(res, 200, { enabled: Boolean(row.totp_secret), recoveryLeft: JSON.parse(row.recovery_codes || "[]").length });
});

route("POST", /^\/api\/2fa\/setup$/, async (req, res, user) => {
  if (user.totp) throw new HttpError(409, "2fa_enabled");
  const secret = newTotpSecret();
  db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").run(secret, user.id);
  const uri = otpauthUri(secret, user.email);
  const qr = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0d0c0aff", light: "#f1ede4ff" } });
  send(res, 200, { secret, uri, qr });
});

route("POST", /^\/api\/2fa\/enable$/, async (req, res, user) => {
  const body = await readJson(req);
  const row = db.prepare("SELECT totp_pending FROM users WHERE id = ?").get(user.id);
  if (!row.totp_pending) throw bad("2fa_setup");
  const step = verifyTotp(row.totp_pending, body.code);
  if (step === null) throw bad("code");
  const { codes, hashes } = freshRecoveryCodes();
  db.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ?, recovery_codes = ? WHERE id = ?")
    .run(step, hashes, user.id);
  send(res, 200, { recoveryCodes: codes });
});

/** Désactiver la double authentification ou refaire les codes de secours : mot de passe et code demandés. */
async function confirmIdentity(req, user) {
  const body = await readJson(req);
  const keys = [`pw:${user.id}`];
  const wait = lockedFor(keys);
  if (wait) throw new HttpError(429, "locked", { wait });
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
  if (!(await verifyPassword(String(body.password ?? "").slice(0, 200), row.password_hash))) {
    recordFailure(keys);
    throw bad("current_password");
  }
  if (!checkSecondFactor(user.id, body.code)) {
    recordFailure(keys);
    throw bad("code");
  }
}

route("POST", /^\/api\/2fa\/disable$/, async (req, res, user) => {
  await confirmIdentity(req, user);
  db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, recovery_codes = NULL WHERE id = ?").run(user.id);
  send(res, 200, { ok: true });
});

route("POST", /^\/api\/2fa\/recovery$/, async (req, res, user) => {
  await confirmIdentity(req, user);
  const { codes, hashes } = freshRecoveryCodes();
  db.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?").run(hashes, user.id);
  send(res, 200, { recoveryCodes: codes });
});

/* ---------- Connexion unique (OpenID Connect) ---------- */

const AUTH_METHODS = new Set(["client_secret_basic", "client_secret_post"]);
/** Convention des applis Kosmy (voir docs/integration.md). */
const kosmyDefaults = (base) => ({
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
function dropOrphanClient(clientId) {
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

route("GET", /^\/api\/spaces\/([\w-]{1,40})\/sso$/, (req, res, user, [id]) => {
  const { space, client } = spaceForSso(user, id);
  // Une autre personne a peut-être déjà relié cette instance : l'appli est alors déjà réglée.
  const existing = client ? null : db.prepare("SELECT 1 FROM sso_clients WHERE base = ?").get(space.base);
  send(res, 200, { ...ssoOut(user, space, client), existing: Boolean(existing) });
});

/* Activer : rejoint le client de cette instance s'il existe, sinon en crée un (son secret n'est montré qu'à ce moment). */
route("POST", /^\/api\/spaces\/([\w-]{1,40})\/sso$/, async (req, res, user, [id]) => {
  const body = await readJson(req);
  const { space, client } = spaceForSso(user, id);
  if (client) throw new HttpError(409, "sso_enabled");
  const existing = db.prepare("SELECT * FROM sso_clients WHERE base = ?").get(space.base);
  if (existing) {
    db.prepare("UPDATE spaces SET client_id = ? WHERE user_id = ? AND id = ?").run(existing.client_id, user.id, id);
    send(res, 200, ssoOut(user, space, existing));
    return;
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
  send(res, 201, ssoOut(user, space, getClient(clientId), secret));
});

route("PUT", /^\/api\/spaces\/([\w-]{1,40})\/sso$/, async (req, res, user, [id]) => {
  const input = ssoInput(await readJson(req));
  const { space, client } = spaceForSso(user, id);
  if (!client) throw new HttpError(404, "sso_disabled");
  if (!canManage(user, client)) throw new HttpError(403, "sso_manage");
  const update = db.prepare("UPDATE sso_clients SET redirect_uris = ?, initiate_login_uri = ?, auth_method = ? WHERE client_id = ?");
  update.run(JSON.stringify(input.redirectUris), input.initiateLoginUri, input.authMethod, client.client_id);
  await assertClientUsable(client.client_id, () =>
    update.run(client.redirect_uris, client.initiate_login_uri, client.auth_method, client.client_id));
  send(res, 200, ssoOut(user, space, getClient(client.client_id)));
});

/* Nouveau secret : l'ancien cesse de fonctionner tout de suite. */
route("POST", /^\/api\/spaces\/([\w-]{1,40})\/sso\/secret$/, (req, res, user, [id]) => {
  const { space, client } = spaceForSso(user, id);
  if (!client) throw new HttpError(404, "sso_disabled");
  if (!canManage(user, client)) throw new HttpError(403, "sso_manage");
  const secret = token(32);
  db.prepare("UPDATE sso_clients SET secret = ?, secret_at = ? WHERE client_id = ?").run(secret, Date.now(), client.client_id);
  send(res, 200, ssoOut(user, space, getClient(client.client_id), secret));
});

/* Désactiver pour cet espace. Le client disparaît quand plus personne ne l'utilise. */
route("DELETE", /^\/api\/spaces\/([\w-]{1,40})\/sso$/, (req, res, user, [id]) => {
  const { client } = spaceForSso(user, id);
  if (!client) throw new HttpError(404, "sso_disabled");
  tx(() => {
    db.prepare("UPDATE spaces SET client_id = NULL WHERE user_id = ? AND id = ?").run(user.id, id);
    dropOrphanClient(client.client_id);
  });
  send(res, 200, { ok: true });
});

/* ---------- Admin dans le Board (docs/admin-api.md) ---------- */

/** L'admin dans le Board passe par la connexion unique : l'appli reconnaît la personne par son « sub ». */
function spaceForAdmin(user, id) {
  const space = getSpace(user.id, id);
  if (!space) throw new HttpError(404, "not_found");
  if (!space.client_id) throw new HttpError(409, "admin_no_sso");
  return space;
}
/** Langue de l'interface (?lang=), sinon celle du compte. */
function adminLang(req, user) {
  const q = new URL(req.url, "http://board").searchParams.get("lang");
  return cleanLang(q) ?? user.lang ?? "fr";
}
function sectionId(v) {
  if (!SECTION_ID.test(v)) throw new HttpError(404, "admin_not_found");
  return v;
}
const appCall = (req, user, space, opts) =>
  callApp({ base: space.base, clientId: space.client_id, user, lang: adminLang(req, user), ...opts });

route("GET", /^\/api\/spaces\/([\w-]{1,40})\/admin$/, async (req, res, user, [id]) => {
  const space = spaceForAdmin(user, id);
  send(res, 200, cleanManifest(await appCall(req, user, space, {})));
});

route("GET", /^\/api\/spaces\/([\w-]{1,40})\/admin\/([^/]{1,60})$/, async (req, res, user, [id, sec]) => {
  const section = sectionId(sec);
  const space = spaceForAdmin(user, id);
  send(res, 200, cleanSection(await appCall(req, user, space, { section }), space.base, section));
});

route("POST", /^\/api\/spaces\/([\w-]{1,40})\/admin\/([^/]{1,60})$/, async (req, res, user, [id, sec]) => {
  const section = sectionId(sec);
  const input = cleanActionInput(await readJson(req, 500_000));
  const space = spaceForAdmin(user, id);
  const data = await appCall(req, user, space, { method: "POST", section, body: input });
  send(res, 200, cleanResult(data, space.base, section));
});

/* ---------- Aiguillage ---------- */

export async function handleApi(req, res, pathname) {
  try {
    const methodRoutes = routes.filter((r) => r.pattern.test(pathname));
    if (!methodRoutes.length) throw new HttpError(404, "not_found");
    const r = methodRoutes.find((x) => x.method === req.method);
    if (!r) throw new HttpError(405, "method");
    // Protection CSRF : inutile pour un appareil, qui s'authentifie par un en-tête qu'un autre site ne peut pas envoyer.
    if (req.method !== "GET" && r.csrf !== false && !hasAuthorization(req) && !sameOrigin(req)) throw new HttpError(403, "origin");
    let user = null;
    if (r.auth !== false) {
      user = currentUser(req);
      if (!user) throw new HttpError(401, "auth");
      if (r.admin && user.role !== "admin") throw new HttpError(403, "admin");
    }
    await r.handler(req, res, user, pathname.match(r.pattern).slice(1));
  } catch (e) {
    if (e instanceof HttpError) {
      if (!res.headersSent) send(res, e.status, { error: e.code, ...(e.extra || {}) });
    } else {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: "server" });
    }
  }
}

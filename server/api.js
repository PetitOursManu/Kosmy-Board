/* Routes /api du Board. Toutes répondent en JSON. */
import { randomBytes } from "node:crypto";

import { normalizeBase, normalizePath } from "../public/js/normalize.js";
import {
  checkPassword, checkSetupCode, clearFailures, consumeSetupCode, createSession, currentUser, destroySession,
  dummyVerify, hashPassword, lockedFor, needsSetup, newUserId, recordFailure, sha256, token, verifyPassword,
} from "./auth.js";
import { config } from "./config.js";
import { db, tx } from "./db.js";
import { bad, clientIp, HttpError, readJson, sameOrigin, send } from "./http.js";

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

const spaceOut = (r) => ({
  id: r.id, appId: r.app_id, name: r.name, base: r.base, path: r.path, addedAt: r.added_at,
  ...(r.opened_at ? { openedAt: r.opened_at } : {}),
});
const userOut = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, lang: u.lang ?? null });
const newSpaceId = () => `${Date.now().toString(36)}${randomBytes(4).toString("hex").slice(0, 5)}`;

/* ---------- Routes ---------- */

const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

route("GET", /^\/api\/state$/, (req, res) => {
  const user = currentUser(req);
  send(res, 200, {
    setupNeeded: needsSetup(),
    user: user ? userOut(user) : null,
    config: { kosmyUrl: config.kosmyUrl, catalogUrl: config.catalogUrl, publicUrl: config.publicUrl },
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

route("POST", /^\/api\/login$/, async (req, res) => {
  const body = await readJson(req);
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
  createSession(res, user.id);
  send(res, 200, { ok: true });
}, { auth: false });

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
  const rows = db.prepare("SELECT * FROM spaces WHERE user_id = ? ORDER BY COALESCE(opened_at, added_at) DESC").all(user.id);
  send(res, 200, { spaces: rows.map(spaceOut) });
});

route("POST", /^\/api\/spaces$/, async (req, res, user) => {
  const s = cleanSpace(await readJson(req));
  if (db.prepare("SELECT COUNT(*) AS n FROM spaces WHERE user_id = ?").get(user.id).n >= MAX_SPACES) throw bad("too_many");
  const row = { id: newSpaceId(), added_at: Date.now() };
  db.prepare("INSERT INTO spaces (user_id, id, app_id, name, base, path, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(user.id, row.id, s.appId, s.name, s.base, s.path, row.added_at);
  send(res, 201, { space: spaceOut(db.prepare("SELECT * FROM spaces WHERE user_id = ? AND id = ?").get(user.id, row.id)) });
});

route("PUT", /^\/api\/spaces\/([\w-]{1,40})$/, async (req, res, user, [id]) => {
  const s = cleanSpace(await readJson(req));
  const r = db.prepare("UPDATE spaces SET app_id = ?, name = ?, base = ?, path = ? WHERE user_id = ? AND id = ?")
    .run(s.appId, s.name, s.base, s.path, user.id, id);
  if (!r.changes) throw new HttpError(404, "not_found");
  send(res, 200, { space: spaceOut(db.prepare("SELECT * FROM spaces WHERE user_id = ? AND id = ?").get(user.id, id)) });
});

route("DELETE", /^\/api\/spaces\/([\w-]{1,40})$/, (req, res, user, [id]) => {
  const r = db.prepare("DELETE FROM spaces WHERE user_id = ? AND id = ?").run(user.id, id);
  if (!r.changes) throw new HttpError(404, "not_found");
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
  send(res, 200, { format: "kosmy.admin.v1", exportedAt: new Date().toISOString(), spaces: rows.map(spaceOut) }, {
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
  const r = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  if (!r.changes) throw new HttpError(404, "not_found");
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

/* ---------- Aiguillage ---------- */

export async function handleApi(req, res, pathname) {
  try {
    const methodRoutes = routes.filter((r) => r.pattern.test(pathname));
    if (!methodRoutes.length) throw new HttpError(404, "not_found");
    const r = methodRoutes.find((x) => x.method === req.method);
    if (!r) throw new HttpError(405, "method");
    if (req.method !== "GET" && !sameOrigin(req)) throw new HttpError(403, "origin");
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

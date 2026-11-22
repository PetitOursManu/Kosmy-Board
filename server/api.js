/* Routes /api du Board. Toutes répondent en JSON. */
import QRCode from "qrcode";

import {
  checkPassword, checkSetupCode, clearFailures, consumeSetupCode, createDeviceToken, createSession, currentUser, destroySession,
  dummyVerify, hasAuthorization, hashPassword, lockedFor, needsSetup, newUserId, recordFailure, sha256, token, verifyPassword,
} from "./auth.js";
import { config } from "./config.js";
import { db, tx } from "./db.js";
import { bad, clientIp, HttpError, readJson, sameOrigin, send } from "./http.js";
import { cleanActionInput, cleanManifest, cleanResult, cleanSection } from "./admin.js";
import { clientFromBasic, deleteNotifications, listNotifications, markRead, notifyFromClient } from "./notifications.js";
import { createMcpToken, deleteMcpToken, listMcpTokens } from "./mcp.js";
import { ISSUER, listMcpGrants, revokeMcpGrant } from "./oidc.js";
import {
  appCall, cleanSpace, createInvite, createSpace, deleteInvite, deleteSpace, disableSso, enableSso, getSso,
  listMembers, listSpaceRows, MAX_SPACES, newSpaceId, removeMember, rotateSsoSecret, sectionId, spaceForAdmin, spaceOut,
  updateSpace, updateSso,
} from "./spaces.js";
import { newRecoveryCodes, newTotpSecret, normalizeRecovery, otpauthUri, verifyTotp } from "./totp.js";
import {
  addUserMessage, auditEntries, checkRate, conversationOut, createConversation, decidePending, deleteConversation, getConversation,
  listConversations, pendingConversation, respond,
} from "./ai/agent.js";
import { aiTarget, cleanBaseUrl, preset as providerPreset, publicAiConfig, saveAiConfig } from "./ai/config.js";
import { AiError, listModels, testTarget } from "./ai/providers.js";
import { runReport } from "./ai/reports.js";
import { takeReveal } from "./ai/reveals.js";
import { reportSettings, saveReportSettings } from "./ai/tools.js";

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

const userOut = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, lang: u.lang ?? null,
  totp: Boolean(u.totp ?? u.totp_secret),
});

/* ---------- Routes ---------- */

const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

route("GET", /^\/api\/state$/, (req, res) => {
  const user = currentUser(req);
  send(res, 200, {
    setupNeeded: needsSetup(),
    user: user ? userOut(user) : null,
    config: { kosmyUrl: config.kosmyUrl, catalogUrl: config.catalogUrl, publicUrl: config.publicUrl, issuer: ISSUER },
    ...(user ? { assistant: { configured: publicAiConfig().configured } } : {}),
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
  send(res, 200, { spaces: listSpaceRows(user.id).map((r) => spaceOut(r)) });
});

route("POST", /^\/api\/spaces$/, async (req, res, user) => {
  send(res, 201, { space: spaceOut(createSpace(user, await readJson(req))) });
});

route("PUT", /^\/api\/spaces\/([\w-]{1,40})$/, async (req, res, user, [id]) => {
  send(res, 200, { space: spaceOut(updateSpace(user, id, await readJson(req))) });
});

route("DELETE", /^\/api\/spaces\/([\w-]{1,40})$/, (req, res, user, [id]) => {
  deleteSpace(user, id);
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
  send(res, 200, listMembers());
}, { admin: true });

/* Le lien n'est montré qu'une fois : seul son haché est conservé. */
route("POST", /^\/api\/invites$/, async (req, res, user) => {
  const body = await readJson(req);
  send(res, 201, createInvite(user, body.role));
}, { admin: true });

route("DELETE", /^\/api\/invites\/([\w-]{1,40})$/, (req, res, user, [id]) => {
  deleteInvite(id);
  send(res, 200, { ok: true });
}, { admin: true });

route("DELETE", /^\/api\/users\/([\w-]{1,40})$/, (req, res, user, [id]) => {
  removeMember(user, id);
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

route("GET", /^\/api\/spaces\/([\w-]{1,40})\/sso$/, (req, res, user, [id]) => {
  send(res, 200, getSso(user, id));
});

/* Activer : rejoint le client de cette instance s'il existe, sinon en crée un (son secret n'est montré qu'à ce moment). */
route("POST", /^\/api\/spaces\/([\w-]{1,40})\/sso$/, async (req, res, user, [id]) => {
  const { status, sso } = await enableSso(user, id, await readJson(req));
  send(res, status, sso);
});

route("PUT", /^\/api\/spaces\/([\w-]{1,40})\/sso$/, async (req, res, user, [id]) => {
  send(res, 200, await updateSso(user, id, await readJson(req)));
});

/* Nouveau secret : l'ancien cesse de fonctionner tout de suite. */
route("POST", /^\/api\/spaces\/([\w-]{1,40})\/sso\/secret$/, (req, res, user, [id]) => {
  send(res, 200, rotateSsoSecret(user, id));
});

/* Désactiver pour cet espace. Le client disparaît quand plus personne ne l'utilise. */
route("DELETE", /^\/api\/spaces\/([\w-]{1,40})\/sso$/, (req, res, user, [id]) => {
  disableSso(user, id);
  send(res, 200, { ok: true });
});

/* ---------- Admin dans le Board (docs/admin-api.md) ---------- */

/** Langue de l'interface (?lang=), sinon celle du compte. */
function adminLang(req, user) {
  const q = new URL(req.url, "http://board").searchParams.get("lang");
  return cleanLang(q) ?? user.lang ?? "fr";
}

route("GET", /^\/api\/spaces\/([\w-]{1,40})\/admin$/, async (req, res, user, [id]) => {
  const space = spaceForAdmin(user, id);
  send(res, 200, cleanManifest(await appCall(user, space, adminLang(req, user))));
});

route("GET", /^\/api\/spaces\/([\w-]{1,40})\/admin\/([^/]{1,60})$/, async (req, res, user, [id, sec]) => {
  const section = sectionId(sec);
  const space = spaceForAdmin(user, id);
  send(res, 200, cleanSection(await appCall(user, space, adminLang(req, user), { section }), space.base, section));
});

route("POST", /^\/api\/spaces\/([\w-]{1,40})\/admin\/([^/]{1,60})$/, async (req, res, user, [id, sec]) => {
  const section = sectionId(sec);
  const input = cleanActionInput(await readJson(req, 500_000));
  const space = spaceForAdmin(user, id);
  const data = await appCall(user, space, adminLang(req, user), { method: "POST", section, body: input });
  send(res, 200, cleanResult(data, space.base, section));
});

/* ---------- Notifications (docs/notifications.md) ---------- */

/*
 * Envoi par une appli reliée : identifiant et secret client de sa connexion unique, en « Authorization: Basic ».
 * Pas de cookie ni de vérification d'origine : c'est un serveur qui appelle, pas un navigateur.
 */
route("POST", /^\/api\/apps\/notifications$/, async (req, res) => {
  const keys = [`app:${clientIp(req)}`];
  const wait = lockedFor(keys);
  if (wait) throw new HttpError(429, "locked", { wait });
  const client = clientFromBasic(req.headers.authorization);
  if (!client) {
    recordFailure(keys);
    res.setHeader("WWW-Authenticate", 'Basic realm="Kosmy Board"');
    throw new HttpError(401, "client_auth");
  }
  const body = await readJson(req, 20_000);
  send(res, 200, { delivered: notifyFromClient(client, body) });
}, { auth: false, csrf: false });

const afterParam = (req) => {
  const v = Number(new URL(req.url, "http://board").searchParams.get("after"));
  return Number.isSafeInteger(v) && v > 0 ? v : 0;
};

route("GET", /^\/api\/notifications$/, (req, res, user) => {
  send(res, 200, listNotifications(user.id, { after: afterParam(req) }));
});

/* Marquer comme lues : { ids: [...] }, ou toutes sans « ids ». */
route("POST", /^\/api\/notifications\/read$/, async (req, res, user) => {
  const body = await readJson(req);
  markRead(user.id, body.ids);
  send(res, 200, listNotifications(user.id));
});

route("DELETE", /^\/api\/notifications$/, (req, res, user) => {
  deleteNotifications(user.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/api\/notifications\/(\d{1,15})$/, (req, res, user, [id]) => {
  deleteNotifications(user.id, Number(id));
  send(res, 200, { ok: true });
});

/* ---------- Assistant (docs/assistant.md) ---------- */

/**
 * Réponse en flux (Server-Sent Events) : chaque événement de l'agent part aussitôt vers l'interface.
 * Un commentaire toutes les 20 secondes garde la connexion ouverte derrière un proxy (Cloudflare coupe après ~100 s de silence).
 * Si la personne ferme la page, l'appel au fournisseur est interrompu.
 */
async function streamAgent(req, res, run) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  const emit = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const beat = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 20_000);
  const ctrl = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ctrl.abort();
  });
  try {
    await run(emit, ctrl.signal);
    emit("done", {});
  } catch (e) {
    if (e instanceof HttpError) emit("error", { error: e.code, ...(e.extra || {}) });
    else {
      console.error("Assistant :", e);
      emit("error", { error: "server" });
    }
  } finally {
    clearInterval(beat);
    res.end();
  }
}

const assistantLang = (body, user) => cleanLang(body.lang) ?? user.lang ?? "fr";

route("GET", /^\/api\/assistant$/, (req, res, user) => {
  const ai = publicAiConfig();
  send(res, 200, {
    configured: ai.configured,
    canConfigure: user.role === "admin",
    provider: ai.providers.find((p) => p.id === ai.provider)?.label ?? ai.provider,
    model: ai.model,
    conversations: listConversations(user.id),
    report: reportSettings(user.id),
  });
});

route("GET", /^\/api\/assistant\/conversations\/([\w-]{6,40})$/, (req, res, user, [id]) => {
  send(res, 200, conversationOut(user.id, id));
});

route("DELETE", /^\/api\/assistant\/conversations\/([\w-]{6,40})$/, (req, res, user, [id]) => {
  deleteConversation(user.id, id);
  send(res, 200, { ok: true });
});

/* Un message : { text, conversation? (sinon une nouvelle), lang }. Réponse en flux. */
route("POST", /^\/api\/assistant\/messages$/, async (req, res, user) => {
  const body = await readJson(req, 50_000);
  const text = str(body.text, 8000);
  if (!text) throw bad("ai_empty");
  if (!publicAiConfig().configured) throw new HttpError(409, "ai_not_configured");
  let conv = body.conversation ? getConversation(user.id, String(body.conversation)) : null;
  if (body.conversation && !conv) throw new HttpError(404, "not_found");
  checkRate(user.id);
  const conversationId = conv?.id ?? createConversation(user.id, text);
  addUserMessage(conversationId, text);
  const lang = assistantLang(body, user);
  await streamAgent(req, res, async (emit, signal) => {
    emit("conversation", { id: conversationId, title: (conv ?? getConversation(user.id, conversationId)).title });
    await respond({ user, lang, conversationId, emit, signal });
  });
});

/* Valider ou refuser une action en attente : { approve, lang }. Validée, l'Assistant reprend la conversation. */
route("POST", /^\/api\/assistant\/pending\/([\w-]{6,40})$/, async (req, res, user, [id]) => {
  const body = await readJson(req);
  const lang = assistantLang(body, user);
  const approve = body.approve === true;
  await streamAgent(req, res, async (emit, signal) => {
    const out = await decidePending({ user, lang, id, approve, emit });
    emit("decision", out);
    const conversationId = pendingConversation(id);
    if (approve && conversationId && publicAiConfig().configured) {
      checkRate(user.id);
      await respond({ user, lang, conversationId, emit, signal });
    }
  });
});

/* Valeur à montrer une fois, produite par un outil appelé depuis le MCP. */
route("POST", /^\/api\/assistant\/reveal\/([\w-]{20,40})$/, (req, res, user, [id]) => {
  const r = takeReveal(user.id, id);
  if (!r) throw new HttpError(410, "ai_reveal_gone");
  send(res, 200, r);
});

route("PUT", /^\/api\/assistant\/report$/, async (req, res, user) => {
  send(res, 200, saveReportSettings(user.id, await readJson(req)));
});

/* Un bilan tout de suite : il tourne en arrière-plan et arrive en notification. */
route("POST", /^\/api\/assistant\/report\/run$/, (req, res, user) => {
  if (!publicAiConfig().configured) throw new HttpError(409, "ai_not_configured");
  checkRate(user.id);
  saveReportSettings(user.id, {}); // crée la ligne si besoin (last_run_at y est noté)
  runReport(user).catch((e) => console.error("Bilan :", e));
  send(res, 202, { ok: true });
});

route("GET", /^\/api\/assistant\/audit$/, (req, res, user) => {
  const all = user.role === "admin" && new URL(req.url, "http://board").searchParams.get("all") === "1";
  send(res, 200, { entries: auditEntries(all ? null : user.id) });
});

/* ---------- Accès MCP : jetons personnels et autorisations OAuth (Compte → Accès MCP) ---------- */

route("GET", /^\/api\/mcp$/, (req, res, user) => {
  send(res, 200, { url: `${config.publicUrl}/mcp`, tokens: listMcpTokens(user.id), grants: listMcpGrants(user.id) });
});

/* Le jeton n'est montré qu'une fois. */
route("POST", /^\/api\/mcp\/tokens$/, async (req, res, user) => {
  const body = await readJson(req);
  send(res, 201, createMcpToken(user.id, body.name));
});

route("DELETE", /^\/api\/mcp\/tokens\/([\w-]{6,40})$/, (req, res, user, [id]) => {
  deleteMcpToken(user.id, id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/api\/mcp\/grants\/([\w-]{6,80})$/, (req, res, user, [id]) => {
  if (!revokeMcpGrant(user.id, id)) throw new HttpError(404, "not_found");
  send(res, 200, { ok: true });
});

/* Réglage du fournisseur d'IA : administrateurs du Board. */
route("GET", /^\/api\/assistant\/settings$/, (req, res) => {
  send(res, 200, publicAiConfig());
}, { admin: true });

route("PUT", /^\/api\/assistant\/settings$/, async (req, res) => {
  send(res, 200, saveAiConfig(await readJson(req)));
}, { admin: true });

/** Le réglage en vigueur, modifié par ce que l'interface n'a pas encore enregistré (essai avant d'enregistrer). */
function draftTarget(body) {
  const cur = aiTarget();
  const sameProvider = !body.provider || body.provider === cur.provider;
  const p = body.provider ? providerPreset(body.provider) : null;
  return {
    ...cur,
    baseUrl: body.baseUrl ? cleanBaseUrl(body.baseUrl) : sameProvider ? cur.baseUrl : p.baseUrl,
    model: str(body.model, 200) || (sameProvider ? cur.model : p.model),
    apiKey: str(body.apiKey, 500) || (sameProvider ? cur.apiKey : ""),
  };
}

async function aiCall(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AiError) throw new HttpError(502, e.code, e.message && e.message !== e.code ? { message: e.message } : undefined);
    throw e;
  }
}

route("POST", /^\/api\/assistant\/models$/, async (req, res) => {
  const target = draftTarget(await readJson(req));
  send(res, 200, { models: await aiCall(() => listModels(target)) });
}, { admin: true });

route("POST", /^\/api\/assistant\/test$/, async (req, res) => {
  const target = draftTarget(await readJson(req));
  if (!target.model) throw bad("ai_model");
  send(res, 200, await aiCall(() => testTarget(target)));
}, { admin: true });

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

/*
 * L'admin dans le Board (protocole kosmy.board-admin.v1, voir docs/admin-api.md).
 *
 * Le serveur du Board appelle l'API d'admin de l'instance avec un jeton signé (même clé que les ID tokens),
 * valable 60 secondes pour une seule requête, qui dit seulement qui est la personne (sub). L'appli décide
 * de ses droits. Les réponses de l'appli sont réduites ici à un format strict avant d'aller à l'interface,
 * qui les affiche en texte brut.
 */
import { randomBytes } from "node:crypto";

import { importJWK, SignJWT } from "jose";

import { HttpError } from "./http.js";
import { ISSUER, signingJwk } from "./oidc.js";

export const PROTOCOL = "kosmy.board-admin.v1";
export const ADMIN_PATH = "/api/kosmy-board/admin";
export const TOKEN_TYPE = "kb-admin+jwt";
const TOKEN_TTL = 60;
const TIMEOUT = 15_000;
const MAX_BYTES = 2_000_000;

export const SECTION_ID = /^[a-z0-9-]{1,40}$/;
const ACTION_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/* ---------- Jeton ---------- */

let keyPromise = null;
function privateKey() {
  keyPromise ??= (async () => {
    const jwk = signingJwk();
    return { key: await importJWK(jwk, "RS256"), kid: jwk.kid };
  })();
  return keyPromise;
}

export async function adminToken({ user, clientId, method, url }) {
  const { key, kid } = await privateKey();
  return new SignJWT({ htm: method, htu: url, name: user.name, email: user.email })
    .setProtectedHeader({ alg: "RS256", kid, typ: TOKEN_TYPE })
    .setIssuer(ISSUER)
    .setAudience(clientId)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL}s`)
    .setJti(randomBytes(16).toString("base64url"))
    .sign(key);
}

/* ---------- Appel de l'appli ---------- */

async function readLimited(res) {
  if (!res.body) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new HttpError(502, "admin_invalid");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Message de l'appli, montré tel quel (texte brut) à côté de l'erreur du Board. */
const appMessage = (data) => {
  const m = text(data?.message, 300);
  return m ? { message: m } : {};
};

/**
 * Appelle l'API d'admin de l'instance. `section` vide : le sommaire.
 * Renvoie le JSON de l'appli, ou lance une HttpError avec un code compris par l'interface.
 */
export async function callApp({ base, clientId, user, lang, method = "GET", section = "", body }) {
  const url = `${base}${ADMIN_PATH}${section ? `/${section}` : ""}`;
  const token = await adminToken({ user, clientId, method, url });
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Language": lang,
        "User-Agent": "Kosmy-Board",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new HttpError(502, e?.name === "TimeoutError" ? "admin_timeout" : "admin_unreachable");
  }
  let raw;
  try {
    raw = await readLimited(res);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "admin_unreachable");
  }
  const isJson = /^application\/([\w.+-]+\+)?json/i.test(res.headers.get("content-type") || "");
  let data = null;
  if (isJson) {
    try { data = JSON.parse(raw); } catch { data = null; }
  }

  // Une redirection (souvent vers la page de connexion) ou une page HTML : l'appli ne connaît pas ce protocole.
  if (res.status >= 300 && res.status < 400) throw new HttpError(502, "admin_unsupported");
  if (!res.ok) {
    const code = typeof data?.error === "string" ? data.error : "";
    if (res.status === 401) throw new HttpError(502, "admin_rejected", appMessage(data));
    if (res.status === 403) throw new HttpError(403, code === "not_linked" ? "admin_not_linked" : "admin_forbidden", appMessage(data));
    if (res.status === 404 || res.status === 405) {
      if (!section || !data) throw new HttpError(502, "admin_unsupported");
      throw new HttpError(404, "admin_not_found", appMessage(data));
    }
    if (res.status >= 500) throw new HttpError(502, "admin_app_failed", appMessage(data));
    throw new HttpError(422, "admin_app_error", appMessage(data));
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(502, section ? "admin_invalid" : "admin_unsupported");
  }
  return data;
}

/* ---------- Format strict ---------- */

function text(v, max = 300) {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return "";
  // Caractères de contrôle retirés (sauf retours à la ligne), longueur bornée.
  return v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, max);
}
const id = (v, re = ACTION_ID) => (typeof v === "string" && re.test(v) ? v : "");
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const TONES = new Set(["info", "success", "warning", "danger", "muted"]);
const tone = (v, fallback = "") => (TONES.has(v) ? v : fallback);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== false));

/** Un lien de cellule : seulement vers l'instance elle-même. */
function sameOriginHref(v, base) {
  if (typeof v !== "string" || !v) return undefined;
  try {
    const u = new URL(v, `${base}/`);
    return u.origin === new URL(base).origin && /^https?:$/.test(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const FIELD_TYPES = new Set(["text", "textarea", "email", "url", "number", "password", "select", "checkbox"]);

function field(f) {
  if (!f || typeof f !== "object") return null;
  const name = id(f.name);
  const label = text(f.label, 120);
  if (!name || !label) return null;
  const type = FIELD_TYPES.has(f.type) ? f.type : "text";
  let value;
  if (type === "checkbox") value = f.value === true;
  else if (type === "number") value = num(f.value) ?? (typeof f.value === "string" ? text(f.value, 40) : undefined);
  else if (type !== "password") value = text(f.value, type === "textarea" ? 20_000 : 2000) || undefined;
  const out = strip({
    name, label, type, value,
    required: f.required === true || undefined,
    readOnly: f.readOnly === true || undefined,
    placeholder: text(f.placeholder, 120) || undefined,
    help: text(f.help, 500) || undefined,
    min: type === "number" ? num(f.min) : undefined,
    max: type === "number" ? num(f.max) : undefined,
    step: type === "number" ? num(f.step) : undefined,
    maxLength: type !== "number" && type !== "checkbox" && type !== "select" ? num(f.maxLength) : undefined,
  });
  if (type === "checkbox") out.value = value;
  if (type === "select") {
    out.options = list(f.options, 200)
      .map((o) => (o && typeof o === "object" ? { value: text(o.value, 200), label: text(o.label, 200) || text(o.value, 200) } : null))
      .filter((o) => o && o.label);
    if (!out.options.length) return null;
    out.value = text(f.value, 200) || undefined;
    if (out.value === undefined) delete out.value;
  }
  return out;
}
const fields = (v) => list(v, 60).map(field).filter(Boolean);

function action(a) {
  if (!a || typeof a !== "object") return null;
  const aid = id(a.id);
  const label = text(a.label, 80);
  if (!aid || !label) return null;
  return strip({
    id: aid, label,
    description: text(a.description, 300) || undefined,
    danger: a.danger === true || undefined,
    confirm: text(a.confirm, 500) || undefined,
    fields: Array.isArray(a.fields) && a.fields.length ? fields(a.fields) : undefined,
  });
}
const actions = (v, max = 20) => list(v, max).map(action).filter(Boolean);

function cell(v, base) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v;
  if (typeof v === "number" || typeof v === "string") return text(v, 500);
  if (typeof v === "object") {
    const out = strip({ text: text(v.text, 500), tone: tone(v.tone) || undefined, href: sameOriginHref(v.href, base) });
    return out.text ? out : "";
  }
  return "";
}

function items(v, max = 24) {
  return list(v, max)
    .map((i) => (i && typeof i === "object" ? strip({ label: text(i.label, 120), value: text(i.value, 2000), hint: text(i.hint, 200) || undefined }) : null))
    .filter((i) => i && i.label);
}

function block(b, base) {
  if (!b || typeof b !== "object") return null;
  const title = text(b.title, 120) || undefined;
  switch (b.type) {
    case "notice": {
      const t = text(b.text, 2000);
      return t || title ? strip({ type: "notice", tone: tone(b.tone, "info"), title, text: t }) : null;
    }
    case "stats":
    case "fields": {
      const it = items(b.items, b.type === "stats" ? 12 : 40);
      return it.length ? strip({ type: b.type, title, items: it }) : null;
    }
    case "form": {
      const f = fields(b.fields);
      const act = id(b.action) || id(b.id);
      if (!f.length || !act) return null;
      return strip({ type: "form", id: id(b.id) || act, title, description: text(b.description, 1000) || undefined, action: act, submit: text(b.submit, 60) || undefined, fields: f });
    }
    case "table": {
      const columns = list(b.columns, 12)
        .map((c) => (c && typeof c === "object" ? { key: id(c.key), label: text(c.label, 80) } : null))
        .filter((c) => c && c.key && c.label);
      if (!columns.length) return null;
      const rowActions = actions(b.rowActions);
      const known = new Set(rowActions.map((a) => a.id));
      const rows = list(b.rows, 500)
        .map((r) => {
          if (!r || typeof r !== "object") return null;
          const rid = text(r.id, 200);
          if (!rid) return null;
          const cells = {};
          for (const c of columns) cells[c.key] = cell(r.cells?.[c.key], base);
          const ra = list(r.actions, 20).filter((a) => typeof a === "string" && known.has(a));
          return { id: rid, cells, ...(ra.length ? { actions: [...new Set(ra)] } : {}) };
        })
        .filter(Boolean);
      return strip({
        type: "table", id: id(b.id) || undefined, title, columns, rows,
        rowActions: rowActions.length ? rowActions : undefined,
        actions: Array.isArray(b.actions) && b.actions.length ? actions(b.actions) : undefined,
        empty: text(b.empty, 200) || undefined,
      });
    }
    case "actions": {
      const a = actions(b.items);
      return a.length ? strip({ type: "actions", title, items: a }) : null;
    }
    default:
      return null; // type inconnu (version plus récente du protocole) : ignoré
  }
}

export function cleanManifest(data) {
  if (data.protocol !== PROTOCOL) throw new HttpError(502, "admin_unsupported");
  const sections = list(data.sections, 20)
    .map((s) => (s && typeof s === "object" ? { id: id(s.id, SECTION_ID), title: text(s.title, 60) } : null))
    .filter((s) => s && s.id && s.title);
  if (!sections.length) throw new HttpError(502, "admin_invalid");
  const app = data.app && typeof data.app === "object" ? strip({ name: text(data.app.name, 80), version: text(data.app.version, 40) }) : {};
  const user = data.user && typeof data.user === "object" ? strip({ name: text(data.user.name, 80), role: text(data.user.role, 60) }) : null;
  return { protocol: PROTOCOL, app, ...(user?.name ? { user } : {}), sections };
}

export function cleanSection(data, base, expectedId) {
  if (!data || typeof data !== "object") throw new HttpError(502, "admin_invalid");
  const blocks = list(data.blocks, 30).map((b) => block(b, base)).filter(Boolean);
  return strip({
    id: expectedId,
    title: text(data.title, 80) || undefined,
    description: text(data.description, 1000) || undefined,
    blocks,
  });
}

export function cleanResult(data, base, sectionId) {
  const reveal = data.reveal && typeof data.reveal === "object"
    ? strip({ label: text(data.reveal.label, 120), value: text(data.reveal.value, 4000) })
    : null;
  return strip({
    ok: true,
    message: text(data.message, 300) || undefined,
    section: data.section && typeof data.section === "object" ? cleanSection(data.section, base, sectionId) : undefined,
    reveal: reveal?.label && reveal?.value ? reveal : undefined,
  });
}

/** Ce que l'interface envoie pour une action : vérifié avant de partir vers l'appli. */
export function cleanActionInput(body) {
  const act = id(body.action);
  if (!act) throw new HttpError(400, "admin_action");
  const out = { action: act };
  if (body.row !== undefined && body.row !== null) {
    const row = text(body.row, 200);
    if (!row) throw new HttpError(400, "admin_action");
    out.row = row;
  }
  if (body.values !== undefined) {
    if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) throw new HttpError(400, "admin_action");
    const entries = Object.entries(body.values);
    if (entries.length > 60) throw new HttpError(400, "admin_action");
    out.values = {};
    for (const [k, v] of entries) {
      if (!ACTION_ID.test(k)) throw new HttpError(400, "admin_action");
      if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out.values[k] = v;
      else if (typeof v === "string" && v.length <= 20_000) out.values[k] = v;
      else throw new HttpError(400, "admin_action");
    }
  }
  return out;
}

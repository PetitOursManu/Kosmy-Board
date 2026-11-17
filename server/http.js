/* Petits outils HTTP : réponses JSON, lecture du corps, cookies, erreurs. */
import { config } from "./config.js";

export class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const bad = (code, extra) => new HttpError(400, code, extra);

export function send(res, status, body, headers = {}) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

export async function readJson(req, limit = 1_000_000) {
  const type = req.headers["content-type"] || "";
  if (!type.startsWith("application/json")) throw new HttpError(415, "json_required");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "too_large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw bad("bad_json");
  }
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req) {
  if (config.trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || "?";
}

/**
 * Protection CSRF des requêtes qui modifient quelque chose : elles doivent venir du Board lui-même.
 * (En plus des cookies SameSite=Lax et du corps JSON obligatoire.)
 */
export function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  // Formulaire classique avec Referrer-Policy: no-referrer : le navigateur envoie « Origin: null ».
  // Sec-Fetch-Site (déjà vérifié ci-dessus) suffit alors.
  if (!origin || origin === "null") return Boolean(site);
  if (origin === config.publicOrigin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

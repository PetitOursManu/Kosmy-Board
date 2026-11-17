/* Kosmy Board — serveur : l'interface (fichiers statiques, sans étape de build) et l'API. */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleApi } from "./api.js";
import { ensureSetupCode, purgeExpired } from "./auth.js";
import { config } from "./config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/* Pas d'iframe, pas de script tiers. connect-src reste ouvert : le statut des instances est vérifié depuis le navigateur. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  "font-src https://fonts.gstatic.com",
  `img-src 'self' data: ${new URL(config.catalogUrl).origin}`,
  "connect-src 'self' https: http:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

function securityHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  // Personne ne peut garder la main sur l'onglet du Board ; le Board, lui, retrouve les onglets de ses instances.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (config.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel === "/") rel = "/index.html";
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Introuvable");
    return;
  }
  const etag = `W/"${info.size.toString(36)}-${info.mtimeMs.toString(36)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": rel.startsWith("/assets/") ? "public, max-age=86400" : "no-cache",
    ETag: etag,
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  let pathname;
  try {
    pathname = new URL(req.url, "http://board").pathname;
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (pathname.startsWith("/api/")) return handleApi(req, res, pathname);
  serveStatic(req, res, pathname).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

server.listen(config.port, () => {
  console.log(`Kosmy Board : ${config.publicUrl} (port ${config.port}, données dans ${config.dataDir})`);
  const code = ensureSetupCode();
  if (code) {
    console.log("");
    console.log("  Aucun compte pour l'instant. Code de première configuration :");
    console.log(`  ${code}`);
    console.log("  (à saisir sur la page d'accueil du Board pour créer le compte administrateur)");
    console.log("");
  }
});

purgeExpired();
setInterval(purgeExpired, 3_600_000).unref();

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));

/* Kosmy Board — serveur : l'interface (fichiers statiques, sans étape de build) et l'API. */
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleApi } from "./api.js";
import { ensureSetupCode, purgeExpired } from "./auth.js";
import { config } from "./config.js";
import { handleOidc, ISSUER, MCP_RESOURCE, MCP_SCOPE, purgeOidc, serveAuthServerMetadata } from "./oidc.js";
import { handleMcp, MCP_PATH } from "./mcp.js";
import { purgeAssistant } from "./ai/agent.js";
import { runDueReports } from "./ai/reports.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

/*
 * Version de l'interface : empreinte de ses scripts et styles. index.html les charge sous « v/<version>/ » ;
 * les imports relatifs des modules suivent le même préfixe. Chaque déploiement change donc toutes leurs adresses,
 * et ces fichiers peuvent être gardés en cache sans fin. Indispensable derrière Cloudflare, qui remplace le
 * « no-cache » des fichiers .js et .css par plusieurs heures de cache dans le navigateur.
 */
function hashUi(dir, h = createHash("sha256")) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) hashUi(full, h);
    else if (/\.(js|css|json)$/.test(e.name)) h.update(e.name).update(readFileSync(full));
  }
  return h;
}
const VERSION = hashUi(ROOT).digest("hex").slice(0, 12);
const INDEX = readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace('href="styles.css"', `href="v/${VERSION}/styles.css"`)
  .replace('src="js/app.js"', `src="v/${VERSION}/js/app.js"`);
const INDEX_ETAG = `W/"${createHash("sha256").update(INDEX).digest("hex").slice(0, 16)}"`;

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
const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  "font-src https://fonts.gstatic.com",
  `img-src 'self' data: ${new URL(config.catalogUrl).origin}`,
  "connect-src 'self' https: http:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
];
const CSP = [...CSP_BASE, "form-action 'self'"].join("; ");
/*
 * Connexion unique : les formulaires (refus, déconnexion, réponse form_post) se terminent par une redirection
 * vers l'appli, que « form-action 'self' » bloquerait. oidc-provider ajoute lui-même l'empreinte de ses scripts.
 */
const CSP_OIDC = CSP_BASE.join("; ");

function securityHeaders(res, pathname) {
  res.setHeader("Content-Security-Policy", pathname === "/oidc" || pathname.startsWith("/oidc/") ? CSP_OIDC : CSP);
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
  if (rel === "/" || rel === "/index.html") {
    if (req.headers["if-none-match"] === INDEX_ETAG) return void res.writeHead(304).end();
    res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache", ETag: INDEX_ETAG });
    res.end(req.method === "HEAD" ? undefined : INDEX);
    return;
  }
  // Fichier versionné : « /v/<version>/js/app.js » sert « /js/app.js ».
  let immutable = false;
  const v = rel.match(/^\/v\/([^/]+)(\/.*)$/);
  if (v) {
    immutable = v[1] === VERSION;
    rel = v[2];
  }
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
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : rel.startsWith("/assets/") ? "public, max-age=86400" : "no-cache",
    ETag: etag,
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://board").pathname;
  } catch {
    res.writeHead(400).end();
    return;
  }
  securityHeaders(res, pathname);
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (pathname.startsWith("/api/")) return handleApi(req, res, pathname);
  /* Serveur MCP (docs/assistant.md) et ses métadonnées OAuth. */
  if (pathname === MCP_PATH) return handleMcp(req, res);
  if (pathname === "/.well-known/oauth-protected-resource" || pathname === `/.well-known/oauth-protected-resource${MCP_PATH}`) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({
      resource: MCP_RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Kosmy Board",
      resource_documentation: "https://github.com/PetitOursManu/Kosmy-Board/blob/main/docs/assistant.md",
    }));
    return;
  }
  if (["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/oidc", "/.well-known/openid-configuration/oidc"].includes(pathname)) {
    return serveAuthServerMetadata(req, res);
  }
  if (pathname === "/oidc" || pathname.startsWith("/oidc/")) return handleOidc(req, res, pathname);
  /* Certaines bibliothèques cherchent la découverte à la racine du domaine. */
  if (pathname === "/.well-known/openid-configuration") {
    res.writeHead(307, { Location: "/oidc/.well-known/openid-configuration" }).end();
    return;
  }
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

const purge = () => {
  purgeExpired();
  purgeOidc();
  purgeAssistant();
};
purge();
setInterval(purge, 3_600_000).unref();

/* Bilans de l'Assistant : vérifiés chaque minute. */
setInterval(() => runDueReports().catch((e) => console.error("Bilans :", e)), 60_000).unref();

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));

/* Kosmy Board — réglages du serveur. Tout se règle par variables d'environnement. */
import path from "node:path";

const port = Number(process.env.PORT) || 8767;
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, "");

export const config = {
  port,
  /** Adresse publique du Board (sans « / » final). Sert aux liens d'invitation et, plus tard, d'émetteur OpenID Connect. */
  publicUrl,
  publicOrigin: new URL(publicUrl).origin,
  /** Cookies « Secure » dès que le Board est servi en https. */
  secure: publicUrl.startsWith("https://"),
  /** Lien « ← Kosmy » de l'en-tête : le seul endroit où régler l'adresse du site Kosmy. */
  kosmyUrl: process.env.KOSMY_URL || "http://localhost:8766",
  /** Catalogue partagé avec Kosmy Mobile (les logos sont relatifs à ce fichier). */
  catalogUrl: process.env.CATALOG_URL || "https://raw.githubusercontent.com/PetitOursManu/Kosmy-Mobile/main/catalog/catalog.json",
  dataDir: path.resolve(process.env.DATA_DIR || "data"),
  /** Derrière un reverse proxy (Coolify, Traefik, Caddy…) : lire l'adresse IP du visiteur dans X-Forwarded-For. */
  trustProxy: process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true",
  /** Durée d'une session du Board. */
  sessionDays: Number(process.env.SESSION_DAYS) || 30,
};

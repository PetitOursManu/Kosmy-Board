/* Kosmy Board — réglages du serveur. Tout se règle par variables d'environnement. */
import path from "node:path";

/**
 * Lit une adresse saisie dans une variable d'environnement : `board.mondomaine.fr` devient
 * `https://board.mondomaine.fr` (`http://` pour localhost et 127.0.0.1), sans « / » final.
 * Renvoie { url, added } ou lance une erreur lisible si l'adresse n'est pas valable.
 */
export function parseAddress(raw, name) {
  let value = String(raw ?? "").trim();
  let added = false;
  if (value && !/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value);
    value = (local ? "http://" : "https://") + value;
    added = true;
  }
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} n'est pas une adresse valable : « ${raw} ». Exemple : https://board.mondomaine.fr`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`${name} doit commencer par https:// (ou http:// en local) : « ${raw} ».`);
  }
  if (u.search || u.hash || u.username || u.password) {
    throw new Error(`${name} ne doit contenir que l'adresse, sans « ? », « # » ni identifiants : « ${raw} ».`);
  }
  return { url: u.href.replace(/\/+$/, ""), added };
}

function address(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  try {
    const { url, added } = parseAddress(raw, name);
    if (added) console.warn(`${name} sans « https:// » : ${url} est utilisée. Ajoutez le préfixe dans la variable pour faire taire cet avertissement.`);
    return url;
  } catch (e) {
    console.error(`\n  Réglage invalide. ${e.message}\n`);
    process.exit(1);
  }
}

const port = Number(process.env.PORT) || 8767;
const publicUrl = address("PUBLIC_URL", `http://localhost:${port}`);

export const config = {
  port,
  /** Adresse publique du Board (sans « / » final). Sert aux liens d'invitation et, plus tard, d'émetteur OpenID Connect. */
  publicUrl,
  publicOrigin: new URL(publicUrl).origin,
  /** Cookies « Secure » dès que le Board est servi en https. */
  secure: publicUrl.startsWith("https://"),
  /** Lien « ← Kosmy » de l'en-tête : le seul endroit où régler l'adresse du site Kosmy. */
  kosmyUrl: address("KOSMY_URL", "http://localhost:8766"),
  /** Catalogue partagé avec Kosmy Mobile (les logos sont relatifs à ce fichier). */
  catalogUrl: process.env.CATALOG_URL || "https://raw.githubusercontent.com/PetitOursManu/Kosmy-Mobile/main/catalog/catalog.json",
  dataDir: path.resolve(process.env.DATA_DIR || "data"),
  /** Derrière un reverse proxy (Coolify, Traefik, Caddy…) : lire l'adresse IP du visiteur dans X-Forwarded-For. */
  trustProxy: process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true",
  /** Durée d'une session du Board. */
  sessionDays: Number(process.env.SESSION_DAYS) || 30,
  /** Durée d'une connexion d'appareil (Kosmy Mobile), prolongée à chaque utilisation. */
  deviceDays: Number(process.env.DEVICE_DAYS) || 365,
};

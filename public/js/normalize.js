/* Adresses des instances — partagé par l'interface et le serveur (même logique que Kosmy Mobile). */

export const spaceUrl = (s) => s.base + (s.path.startsWith("/") ? s.path : `/${s.path}`);
export const hostOf = (url) => url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
export const isCleartext = (url) => /^http:\/\//i.test(url);

/**
 * Nettoie l'adresse saisie : ajoute https:// si besoin, retire la page d'admin si elle a été collée avec.
 * Renvoie { base } ou { error } avec un code d'erreur (traduit par l'interface) :
 * empty, scheme, credentials, invalid.
 */
export function normalizeBase(input, adminPath) {
  let s = String(input ?? "").trim();
  if (!s) return { error: "empty" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const m = s.match(/^(https?):\/\/([^/?#\s]+)(\/[^?#\s]*)?(?:[?#].*)?$/i);
  if (!m) return { error: "scheme" };
  const [, scheme, host, rawPath = ""] = m;
  if (host.includes("@")) return { error: "credentials" };
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(host) || /^\.|\.\.|\.$/.test(host.replace(/:\d+$/, ""))) {
    return { error: "invalid" };
  }
  let path = rawPath.replace(/\/+$/, "");
  if (adminPath && adminPath !== "/" && path.toLowerCase().endsWith(adminPath.replace(/\/+$/, "").toLowerCase())) {
    path = path.slice(0, path.length - adminPath.replace(/\/+$/, "").length);
  }
  return { base: `${scheme.toLowerCase()}://${host.toLowerCase()}${path}` };
}

/** Page d'admin propre : commence par « / », sans espace ni caractère dangereux. null si inutilisable. */
export function normalizePath(input) {
  let p = String(input ?? "").trim() || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 300 || /[\s<>"'`\\]/.test(p) || p.startsWith("//")) return null;
  return p;
}

/**
 * Serveur du réseau local (ou de la machine elle-même) : http y est toléré.
 * localhost, *.local, *.lan, *.home.arpa, *.internal, nom sans point, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7.
 */
export function isLocalHost(hostWithPort) {
  const h = hostWithPort.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || !h.includes(".") && !h.includes(":")) return true;
  if (/\.(local|lan|home|home\.arpa|internal|localhost)$/.test(h)) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h);
}

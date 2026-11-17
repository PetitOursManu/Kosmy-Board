/* Catalogue partagé avec Kosmy Mobile : lu sur GitHub, avec une copie de secours embarquée. */

const FALLBACK_URL = "js/catalog-fallback.json";
/** Les logos de la copie de secours sont servis par le Board lui-même. */
const FALLBACK_BASE = "assets/";
const TIMEOUT = 5000;

const isStr = (v) => typeof v === "string" && v.length > 0;
const isColor = (v) => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v);

/** Les entrées incomplètes sont ignorées plutôt que de tout casser (même règle que Kosmy Mobile). */
export function sanitize(raw) {
  if (!raw || typeof raw !== "object" || raw.schema !== 1 || !Array.isArray(raw.themes) || !Array.isArray(raw.apps)) return null;
  const themes = raw.themes
    .filter((t) => isStr(t?.id) && isStr(t?.name?.fr))
    .map((t) => ({ id: t.id, name: { fr: t.name.fr, en: isStr(t.name.en) ? t.name.en : t.name.fr } }));
  const ids = new Set(themes.map((t) => t.id));
  const apps = raw.apps
    .filter((a) =>
      isStr(a?.id) && /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(a.id) && isStr(a?.name) && ids.has(a?.theme) &&
      isColor(a?.color) && isStr(a?.logo) && isStr(a?.repo) && isStr(a?.text?.fr?.line))
    .map((a) => ({
      id: a.id,
      n: isStr(a.n) ? a.n : "",
      name: a.name,
      theme: a.theme,
      color: a.color,
      ink: isColor(a.ink) ? a.ink : "#0d0c0a",
      tile: isColor(a.tile) ? a.tile : null,
      logo: a.logo,
      text: { fr: a.text.fr, en: a.text.en?.line ? a.text.en : a.text.fr },
      admin: typeof a.admin?.path === "string" && a.admin.path.startsWith("/") ? { path: a.admin.path } : null,
    }));
  if (!apps.length) return null;
  return { themes, apps };
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-cache", credentials: "omit" });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const resolve = (base, path) => (/^https:\/\//.test(path) ? path : base + path.replace(/^\/+/, ""));

/** { themes, apps, source, themeById, appById } — chaque appli a logoUrl (et fallbackLogo si le logo vient d'Internet). */
export async function loadCatalog(remoteUrl) {
  let data = null, base = FALLBACK_BASE, source = "bundled";
  if (remoteUrl) {
    try {
      data = sanitize(await fetchJson(remoteUrl));
      if (data) {
        base = remoteUrl.slice(0, remoteUrl.lastIndexOf("/") + 1);
        source = "remote";
      }
    } catch { /* hors ligne ou GitHub indisponible : copie de secours */ }
  }
  if (!data) data = sanitize(await fetchJson(FALLBACK_URL));
  if (!data) throw new Error("catalog");
  for (const a of data.apps) {
    a.logoUrl = resolve(base, a.logo);
    if (source === "remote" && !/^https:/.test(a.logo)) a.fallbackLogo = resolve(FALLBACK_BASE, a.logo);
  }
  return {
    ...data,
    source,
    themeById: Object.fromEntries(data.themes.map((t) => [t.id, t])),
    appById: Object.fromEntries(data.apps.map((a) => [a.id, a])),
  };
}

/* Kosmy Board — démarrage, routes et en-tête. */
import { api, setUnauthorizedHandler } from "./api.js";
import { loadCatalog } from "./catalog.js";
import { errorText, initialLang, lang, setLang, t } from "./i18n.js";
import { $, $$, esc, toast } from "./ui.js";
import { onStatus, getStatus } from "./status.js";
import { spaceUrl } from "./normalize.js";
import { renderAuth } from "./views/auth.js";
import { renderList } from "./views/list.js";
import { renderEdit } from "./views/edit.js";
import { renderAccount } from "./views/account.js";
import { renderSso } from "./views/sso.js";
import { renderAdmin } from "./views/admin.js";
import { renderNotifications } from "./views/notifications.js";
import { renderAssistant, renderReveal } from "./views/assistant.js";
import { renderUsers } from "./views/users.js";

/** État partagé par les vues. */
export const state = {
  user: null,
  setupNeeded: false,
  config: { kosmyUrl: "", catalogUrl: "", publicUrl: "" },
  catalog: null,
  spaces: null,
  /** La personne peut ajouter, modifier et retirer des instances (administrateur du Board). */
  canManage: false,
  /** Notifications non lues (cloche de l'en-tête). */
  unread: 0,
};

/** Titre de page animé mot par mot (le HTML ne contient que des <em> et du texte déjà échappé). */
export function titleHtml(html, delay = 0.08) {
  const words = html.match(/<em>.*?<\/em>|[^\s<]+/g) || [];
  return words.map((w, i) => `<span class="word"><span style="--d:${(delay + i * 0.07).toFixed(2)}s">${w}</span></span>`).join(" ");
}

export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/* ---------- Données ---------- */

export async function refreshSpaces() {
  const { spaces, canManage } = await api.get("api/spaces");
  state.spaces = spaces;
  state.canManage = Boolean(canManage);
  updateHeader();
  return spaces;
}

let catalogPromise = null;
export function catalog() {
  catalogPromise ??= loadCatalog(state.config.catalogUrl).then((c) => (state.catalog = c));
  return catalogPromise;
}

/* ---------- En-tête ---------- */

function updateHeader() {
  document.title = t("title");
  $("#brand").setAttribute("aria-label", t("brand"));
  $("#lang").setAttribute("aria-label", t("langLabel"));
  $$(".lang-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
  $("#foot-note").textContent = t("footNote");

  const kosmy = $("#kosmy-link");
  kosmy.hidden = !state.config.kosmyUrl;
  if (state.config.kosmyUrl) kosmy.href = state.config.kosmyUrl;
  kosmy.textContent = t("backToKosmy");

  const acc = $("#account-link");
  acc.hidden = !state.user;
  if (state.user) {
    const initial = (state.user.name.trim()[0] || "?").toUpperCase();
    acc.innerHTML = `<span class="avatar" aria-hidden="true">${esc(initial)}</span><span>${esc(state.user.name)}</span>`;
    acc.setAttribute("aria-label", `${t("account")} — ${state.user.name}`);
    acc.toggleAttribute("aria-current", location.hash.startsWith("#/compte"));
    if (location.hash.startsWith("#/compte")) acc.setAttribute("aria-current", "page");
  }

  const users = $("#users-link");
  users.hidden = state.user?.role !== "admin";
  users.setAttribute("aria-label", t("usersNav"));
  users.title = t("usersNav");
  if (location.hash.startsWith("#/utilisateurs")) users.setAttribute("aria-current", "page");
  else users.removeAttribute("aria-current");

  const ai = $("#ai-link");
  ai.hidden = !state.user;
  ai.setAttribute("aria-label", t("aiNav"));
  ai.title = t("aiNav");
  if (location.hash.startsWith("#/assistant")) ai.setAttribute("aria-current", "page");
  else ai.removeAttribute("aria-current");

  const bell = $("#bell-link");
  bell.hidden = !state.user;
  const count = $(".bell-count", bell);
  count.hidden = !state.unread;
  count.textContent = state.unread > 99 ? "99+" : String(state.unread);
  bell.setAttribute("aria-label", state.unread ? t("notifBellUnread", state.unread) : t("notifBell"));
  if (location.hash.startsWith("#/notifications")) bell.setAttribute("aria-current", "page");
  else bell.removeAttribute("aria-current");

  const status = $("#top-status");
  status.hidden = !state.user || !state.spaces;
  if (state.spaces) {
    const up = state.spaces.filter((s) => getStatus(spaceUrl(s)) === "up").length;
    $(".status-text", status).textContent = t("statusLine", state.spaces.length, up);
  }
}
onStatus(() => updateHeader());

/* ---------- Notifications ---------- */

export function setUnread(n) {
  state.unread = Number(n) || 0;
  updateHeader();
}

/** Nombre de non lues : relu au chargement, au retour sur l'onglet et toutes les minutes tant que l'onglet est visible. */
export async function refreshUnread() {
  if (!state.user) return;
  try {
    // « after » très grand : aucune notification renvoyée, seulement le compteur.
    const r = await api.get(`api/notifications?after=${Number.MAX_SAFE_INTEGER}`);
    setUnread(r.unread);
  } catch { /* on réessaiera */ }
}
setInterval(() => {
  if (document.visibilityState === "visible") refreshUnread();
}, 60_000);

/* ---------- Routes ---------- */

let firstRoute = true;
let lastRouteKey = "";

export async function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [pathPart, query = ""] = hash.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  const main = $("#main");
  const key = hash;
  const sameRoute = key === lastRouteKey;
  lastRouteKey = key;

  updateHeader();
  if (!sameRoute && !firstRoute) {
    window.scrollTo({ top: 0, behavior: "instant" });
    main.focus({ preventScroll: true });
  }
  firstRoute = false;

  if (parts[0] === "invitation" && parts[1]) return renderAuth(main, "invite", parts[1]);
  // Lien d'activation (compte créé par un administrateur) ou de nouveau mot de passe : connecté ou non.
  if (parts[0] === "activation" && parts[1]) return renderAuth(main, "password", parts[1]);
  // Connexion unique : une appli attend que l'on soit connecté au Board, puis on y retourne.
  const back = safeReturn(params.get("retour"));
  if (!state.user) return renderAuth(main, state.setupNeeded ? "setup" : "login", null, { back, app: params.get("appli") });
  if (back) {
    location.replace(back);
    return;
  }

  await catalog().catch(() => null);
  if (!state.spaces) {
    await refreshSpaces().catch(() => (state.spaces = []));
    refreshUnread();
  }

  switch (parts[0]) {
    case "ajouter":
      if (!state.canManage) return go("#/");
      return renderEdit(main, { appId: params.get("app") });
    case "modifier":
      if (!state.canManage) return go("#/");
      return renderEdit(main, { id: parts[1] });
    case "utilisateurs":
      return renderUsers(main, { id: parts[1] });
    case "compte":
      return renderAccount(main);
    case "connexion-unique":
      return renderSso(main, { id: parts[1] });
    case "admin":
      return renderAdmin(main, { id: parts[1], section: parts[2] });
    case "notifications":
      return renderNotifications(main);
    case "assistant":
      return renderAssistant(main, { id: parts[1], sub: parts[2] });
    case "valeur":
      return renderReveal(main, parts[1]);
    default:
      return renderList(main, { rerender: sameRoute });
  }
}

/** Seul retour accepté : une étape de connexion unique du Board lui-même. */
export function safeReturn(v) {
  return typeof v === "string" && /^\/oidc\/interaction\/[\w-]{1,64}$/.test(v) ? v : null;
}

/** Après connexion ou déconnexion : on relit l'état du serveur. */
export async function reloadState() {
  const s = await api.get("api/state");
  state.user = s.user;
  state.setupNeeded = s.setupNeeded;
  state.config = s.config;
  state.assistant = s.assistant ?? null;
  state.spaces = null;
  return s;
}

/* ---------- Langue ---------- */

$$(".lang-btn").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.lang === lang) return;
    setLang(b.dataset.lang, true);
    if (state.user) api.patch("api/me", { lang }).catch(() => {});
    route();
  }),
);

/* ---------- Démarrage ---------- */

setUnauthorizedHandler(() => {
  if (!state.user) return;
  state.user = null;
  state.spaces = null;
  toast(errorText("auth"), "error");
  route();
});

window.addEventListener("hashchange", route);
/* Retour sur l'onglet du Board : on revérifie les statuts (sur la liste). */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.user) return;
  if (location.hash === "" || location.hash === "#/") route();
  else refreshUnread();
});

(async function boot() {
  setLang(initialLang());
  try {
    const s = await reloadState();
    setLang(initialLang(s.user?.lang));
  } catch {
    $("#main").innerHTML = `<p class="mono boot">${esc(errorText("network"))}</p>`;
    return;
  }
  route();
})();

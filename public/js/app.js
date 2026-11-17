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

/** État partagé par les vues. */
export const state = {
  user: null,
  setupNeeded: false,
  config: { kosmyUrl: "", catalogUrl: "", publicUrl: "" },
  catalog: null,
  spaces: null,
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
  const { spaces } = await api.get("api/spaces");
  state.spaces = spaces;
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

  const status = $("#top-status");
  status.hidden = !state.user || !state.spaces;
  if (state.spaces) {
    const up = state.spaces.filter((s) => getStatus(spaceUrl(s)) === "up").length;
    $(".status-text", status).textContent = t("statusLine", state.spaces.length, up);
  }
}
onStatus(() => updateHeader());

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
  if (!state.user) return renderAuth(main, state.setupNeeded ? "setup" : "login");

  await catalog().catch(() => null);
  if (!state.spaces) await refreshSpaces().catch(() => (state.spaces = []));

  switch (parts[0]) {
    case "ajouter":
      return renderEdit(main, { appId: params.get("app") });
    case "modifier":
      return renderEdit(main, { id: parts[1] });
    case "compte":
      return renderAccount(main);
    default:
      return renderList(main, { rerender: sameRoute });
  }
}

/** Après connexion ou déconnexion : on relit l'état du serveur. */
export async function reloadState() {
  const s = await api.get("api/state");
  state.user = s.user;
  state.setupNeeded = s.setupNeeded;
  state.config = s.config;
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
  if (document.visibilityState === "visible" && state.user && (location.hash === "" || location.hash === "#/")) route();
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

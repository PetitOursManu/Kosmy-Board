/* Liste des espaces : recherche, filtre par thème, statut, ouverture dans un onglet. */
import { api } from "../api.js";
import { state, titleHtml } from "../app.js";
import { errorText, lang, relTime, t } from "../i18n.js";
import { hostOf, isCleartext, isLocalHost, spaceUrl } from "../normalize.js";
import { check, getStatus, onStatus, checkable } from "../status.js";
import { $, $$, colorsOf, confirmBox, esc, logoTile, reducedMotion, toast } from "../ui.js";

let query = "";
let theme = "all";

const appOf = (s) => (s.appId ? state.catalog?.appById[s.appId] : undefined);
const themeOf = (s) => appOf(s)?.theme ?? "other";
/** Page d'accueil de l'appli (racine de l'instance). */
const homeUrl = (s) => `${s.base}/`;
/** Une page d'admin distincte de l'accueil : sinon le bouton « Admin » ferait doublon avec « Ouvrir ». */
const hasAdminPage = (s) => s.path !== "/" && s.path !== "";
/**
 * Adresse ouverte par un clic sur la ligne (ou « Ouvrir ») : l'accueil de l'appli ; par « Admin » : sa page d'admin.
 * Avec la connexion unique et une adresse de lancement, l'appli démarre elle-même la connexion avec le Board
 * (OpenID Connect, connexion initiée par un tiers), puis arrive sur la page demandée.
 */
function openUrl(s, admin = false) {
  const target = admin ? spaceUrl(s) : homeUrl(s);
  if (!s.sso?.loginUri || !state.config.issuer) return target;
  const u = new URL(s.sso.loginUri);
  u.searchParams.set("iss", state.config.issuer);
  u.searchParams.set("target_link_uri", target);
  return u.href;
}
/**
 * Nom propre à chaque espace : l'onglet de l'instance est réutilisé à chaque ouverture.
 * L'admin a son propre onglet, sinon « Ouvrir » ramènerait l'onglet resté sur l'admin (et inversement).
 */
const windowName = (s, admin = false) => `kosmy-board-${s.id}${admin ? "-admin" : ""}`;

function stateHtml(url) {
  const st = getStatus(url) ?? "checking";
  const label = { up: t("statusUp"), down: t("statusDown"), unknown: t("statusUnknown"), checking: t("statusChecking") }[st];
  const title = st === "unknown" ? ` title="${esc(t("statusUnknownHint"))}"` : "";
  return `<span class="state" data-state="${st}"${title}><i aria-hidden="true"></i><span>${esc(label)}</span></span>`;
}

function rowHtml(s, i, animate) {
  const app = appOf(s);
  const { c, ink } = colorsOf(app);
  const url = spaceUrl(s);
  const open = openUrl(s);
  const host = hostOf(s.base);
  const themeName = app ? state.catalog.themeById[app.theme]?.name[lang] : t("otherApp");
  const opened = s.openedAt ? t("openedAgo", relTime(s.openedAt)) : t("neverOpened");
  const target = windowName(s);
  return `
    <article class="row${animate ? " enter" : ""}" style="--c:${c};--ink:${ink};--d:${Math.min(i, 8) * 0.06}s" data-id="${esc(s.id)}" data-url="${esc(url)}"
      data-search="${esc(`${s.name} ${host} ${app?.name ?? ""}`.toLowerCase())}" data-theme="${esc(themeOf(s))}">
      <a class="cover" href="${esc(open)}" target="${target}" rel="noopener noreferrer" tabindex="-1" aria-hidden="true"></a>
      <span class="meta-l mono"><span class="n">${String(i + 1).padStart(2, "0")}</span>${stateHtml(url)}</span>
      ${logoTile(app, s.name)}
      <span class="title">
        <span class="name serif">${esc(s.name)}</span>
        <span class="host mono"><span>${esc(host)}${s.path !== "/" ? esc(s.path) : ""}</span>${isCleartext(s.base) ? `<span class="tag-warn${isLocalHost(host) ? " local" : ""}" title="${esc(t(isLocalHost(host) ? "cleartextLocal" : "cleartextWarning"))}">${esc(t("cleartext"))}</span>` : ""}${s.sso ? `<span class="tag-sso">${esc(t("ssoTag"))}</span>` : ""}</span>
      </span>
      <span class="meta-r mono"><span class="opened">${esc(opened)}</span><span>${esc(themeName ?? "")}</span></span>
      <span class="actions mono">
        <a class="open-btn" href="${esc(open)}" target="${target}" rel="noopener noreferrer" aria-label="${esc(t("openLabel", s.name, host))}">${esc(t("open"))} <span class="arrow" aria-hidden="true">↗</span></a>
        ${hasAdminPage(s) ? `<a class="open-btn alt" href="${esc(openUrl(s, true))}" target="${windowName(s, true)}" rel="noopener noreferrer" data-admin aria-label="${esc(t("adminLabel", s.name, host))}">${esc(t("admin"))}</a>` : ""}
        <a class="text-btn" href="#/modifier/${encodeURIComponent(s.id)}" aria-label="${esc(`${t("edit")} ${s.name}`)}">${esc(t("edit"))}</a>
        <button class="text-btn danger" type="button" data-remove aria-label="${esc(`${t("remove")} ${s.name}`)}">${esc(t("remove"))}</button>
      </span>
    </article>`;
}

function emptyHtml() {
  const apps = (state.catalog?.apps ?? []).filter((a) => a.admin);
  return `
    <div class="empty fade" style="--d:.3s">
      <p class="mono">${esc(t("emptyTitle"))}</p>
      <p>${esc(t("emptyText"))}</p>
      <div class="quick">
        ${apps.map((a) => `<a href="#/ajouter?app=${encodeURIComponent(a.id)}" aria-label="${esc(`${t("add")} — ${a.name}`)}">${logoTile(a, a.name)}<span class="mono">${esc(a.name)}</span></a>`).join("")}
        <a href="#/ajouter?app=autre" aria-label="${esc(`${t("add")} — ${t("otherApp")}`)}">${logoTile(null, "+")}<span class="mono">${esc(t("otherApp"))}</span></a>
      </div>
    </div>`;
}

function chipsHtml(spaces) {
  const counts = { all: spaces.length, other: 0 };
  for (const s of spaces) counts[themeOf(s)] = (counts[themeOf(s)] ?? 0) + 1;
  const list = [
    { id: "all", name: t("all") },
    ...(state.catalog?.themes ?? []).map((th) => ({ id: th.id, name: th.name[lang] })),
    { id: "other", name: t("others") },
  ];
  if (theme !== "all" && !counts[theme]) theme = "all";
  return list
    .map((c) => `<button class="chip mono" type="button" data-theme="${esc(c.id)}" aria-pressed="${theme === c.id}" ${counts[c.id] ? "" : "disabled"}>${esc(c.name)}<small>${counts[c.id] ?? 0}</small></button>`)
    .join("");
}

/** Applique la recherche et le filtre sans reconstruire la liste (le champ garde le focus). */
function applyFilter(main) {
  const q = query.trim().toLowerCase();
  let n = 0;
  for (const row of $$(".row", main)) {
    const show = (theme === "all" || row.dataset.theme === theme) && (!q || row.dataset.search.includes(q));
    row.hidden = !show;
    if (show) n++;
  }
  const count = $("#count", main);
  if (count) count.textContent = t("results", n);
  const none = $("#no-match", main);
  if (none) none.hidden = n > 0;
  $$(".chip", main).forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.theme === theme)));
}

function checkAll(force = false) {
  for (const s of state.spaces ?? []) check(spaceUrl(s), force);
}

/* Les statuts arrivent après l'affichage : on met à jour les lignes concernées. */
onStatus((url) => {
  for (const row of $$(".row")) if (row.dataset.url === url) $(".state", row).outerHTML = stateHtml(url);
});

/**
 * Ouvre l'instance dans l'onglet qui porte son nom, ou ramène cet onglet s'il est déjà ouvert (sans le recharger).
 * « noopener » ferait ignorer le nom par le navigateur (un nouvel onglet à chaque clic) : on coupe donc le lien
 * avec le Board juste après l'ouverture (opener = null), ce qui revient au même pour la sécurité.
 * Une instance qui envoie Cross-Origin-Opener-Policy (Dashy, via helmet) s'ouvre dans un nouvel onglet à chaque fois.
 */
function openInTab(url, name) {
  const w = window.open("", name);
  if (!w) {
    // Fenêtres surgissantes bloquées : on ouvre l'adresse simplement, dans un nouvel onglet.
    window.open(url, "_blank", "noopener");
    return;
  }
  let fresh;
  try {
    fresh = w.location.href === "about:blank";
  } catch {
    fresh = false; // l'onglet affiche déjà l'instance (autre origine)
  }
  if (fresh) {
    w.opener = null;
    w.location.replace(url);
  } else {
    w.focus();
  }
}

async function openSpace(s, e, admin = false) {
  const plain = e && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0;
  if (plain) {
    e.preventDefault();
    openInTab(openUrl(s, admin), windowName(s, admin));
  }
  try {
    const { openedAt } = await api.post(`api/spaces/${encodeURIComponent(s.id)}/opened`);
    s.openedAt = openedAt;
    const el = $(`.row[data-id="${CSS.escape(s.id)}"] .opened`);
    if (el) el.textContent = t("openedAgo", relTime(openedAt));
  } catch { /* la date d'ouverture n'est qu'une indication */ }
}

async function removeSpace(main, s) {
  const ok = await confirmBox({ title: t("removeTitle", s.name), text: t("removeText"), ok: t("remove"), danger: true });
  if (!ok) return;
  try {
    await api.del(`api/spaces/${encodeURIComponent(s.id)}`);
    state.spaces = state.spaces.filter((x) => x.id !== s.id);
    toast(t("removed", s.name));
    renderList(main, { rerender: true });
  } catch (ex) {
    toast(errorText(ex.code, ex.extra), "error");
  }
}

export function renderList(main, { rerender = false } = {}) {
  const spaces = state.spaces ?? [];
  const animate = !rerender && !reducedMotion();
  const anyHttpUnchecked = spaces.some((s) => !checkable(spaceUrl(s)));

  main.innerHTML = `
    <section class="page">
      <div class="page-head">
        <div>
          <p class="mono kicker fade">${esc(t("listKicker"))}</p>
          <h1 class="serif page-title">${titleHtml(t("listTitle"))}</h1>
        </div>
        <div class="head-side fade" style="--d:.35s">
          <p class="lead">${esc(t("listText"))}</p>
          <a class="btn signal" href="#/ajouter"><span class="plus" aria-hidden="true">+</span> ${esc(t("add"))}</a>
        </div>
      </div>
      ${spaces.length ? `
        <div class="toolbar fade" style="--d:.45s">
          <div class="field search">
            <label class="mono" for="q">${esc(t("search"))}</label>
            <input class="input" id="q" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(t("searchPlaceholder"))}" value="${esc(query)}">
            <span class="kbd mono" aria-hidden="true">/</span>
          </div>
          <div class="chips" role="group" aria-label="${esc(t("themesLabel"))}">${chipsHtml(spaces)}</div>
          <div class="count mono"><span id="count" aria-live="polite"></span><button class="text-btn mono" type="button" id="recheck">↻ ${esc(t("recheck"))}</button></div>
        </div>
        <div class="rows" id="rows">
          ${spaces.map((s, i) => rowHtml(s, i, animate)).join("")}
          <p class="no-match" id="no-match" hidden>${esc(t("noMatch"))}</p>
        </div>
        <div class="list-foot">
          <p>${esc(t("statusNote"))}${anyHttpUnchecked ? ` ${esc(t("statusUnknownHint"))}` : ""}</p>
          <p>${esc(t("sessionNote"))}</p>
        </div>` : emptyHtml()}
    </section>`;

  if (!spaces.length) return;
  applyFilter(main);
  checkAll();

  const q = $("#q", main);
  q.addEventListener("input", () => { query = q.value; applyFilter(main); });
  $(".chips", main).addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || chip.disabled) return;
    theme = chip.dataset.theme;
    applyFilter(main);
  });
  $("#recheck", main).addEventListener("click", () => checkAll(true));

  $("#rows", main).addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    const s = row && spaces.find((x) => x.id === row.dataset.id);
    if (!s) return;
    if (e.target.closest("[data-remove]")) return removeSpace(main, s);
    const link = e.target.closest("a[target]");
    if (link) openSpace(s, e, link.hasAttribute("data-admin"));
  });
  $("#rows", main).addEventListener("auxclick", (e) => {
    const row = e.target.closest(".row");
    const s = row && spaces.find((x) => x.id === row.dataset.id);
    const link = e.target.closest("a[target]");
    if (s && e.button === 1 && link) openSpace(s, null, link.hasAttribute("data-admin"));
  });
}

/* « / » place le curseur dans la recherche. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || document.querySelector("dialog[open]")) return;
  const q = document.getElementById("q");
  if (q) {
    e.preventDefault();
    q.focus();
  }
});

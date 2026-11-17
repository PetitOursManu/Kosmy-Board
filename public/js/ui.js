/* Outils d'interface : échappement, logos, boîte de confirmation, messages. */
import { t } from "./i18n.js";

const $ = (s, root = document) => root.querySelector(s);
export { $ };
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

/** Toute donnée saisie (noms, adresses) passe par esc() avant d'aller dans innerHTML. */
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Couleur d'accent d'un espace : celle de l'appli, ou le vert citron pour une autre appli web. */
export const SIGNAL = "#c5f04a";
export function colorsOf(app) {
  return app ? { c: app.color, ink: app.ink } : { c: SIGNAL, ink: "#0d0c0a" };
}

/** Tuile de logo : logo de l'appli du catalogue (sur sa couleur « tile » s'il est transparent), ou initiale en Instrument Serif. */
export function logoTile(app, name, cls = "") {
  if (app) {
    const tiled = app.tile ? " tiled" : "";
    const bg = app.tile ? `;background:${app.tile}` : "";
    const fb = app.fallbackLogo ? ` data-fallback="${esc(app.fallbackLogo)}"` : "";
    return `<span class="logo${tiled} ${cls}" style="--c:${app.color}${bg}"><img src="${esc(app.logoUrl)}"${fb} alt="" decoding="async"></span>`;
  }
  const initial = (String(name ?? "").trim()[0] ?? "+").toUpperCase();
  return `<span class="logo generic ${cls}" style="--c:${SIGNAL}" aria-hidden="true"><span class="serif">${esc(initial)}</span></span>`;
}

/* Logo distant indisponible : on passe à la copie embarquée. */
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.dataset.fallback) {
    img.src = img.dataset.fallback;
    delete img.dataset.fallback;
  }
}, true);

/* ---------- Boîte de confirmation ---------- */

export function confirmBox({ title, text, ok, danger = false }) {
  const dlg = $("#confirm");
  $(".confirm-title", dlg).textContent = title;
  $(".confirm-text", dlg).textContent = text;
  const okBtn = $(".confirm-ok", dlg);
  okBtn.textContent = ok;
  okBtn.classList.toggle("danger", danger);
  $(".confirm-cancel", dlg).textContent = t("cancel");
  dlg.returnValue = "";
  dlg.showModal();
  $(".confirm-cancel", dlg).focus();
  return new Promise((resolve) => {
    // On répond dès le clic (l'événement « close » n'arrive pas dans tous les navigateurs intégrés).
    const form = $("form", dlg);
    const done = (ok) => {
      form.removeEventListener("submit", onSubmit);
      dlg.removeEventListener("cancel", onCancel);
      dlg.removeEventListener("close", onClose);
      dlg.removeEventListener("click", onBackdrop);
      if (dlg.open) dlg.close(ok ? "ok" : "");
      resolve(ok);
    };
    const onSubmit = (e) => { e.preventDefault(); done(e.submitter?.value === "ok"); };
    const onCancel = (e) => { e.preventDefault(); done(false); };
    const onClose = () => done(dlg.returnValue === "ok");
    const onBackdrop = (e) => { if (e.target === dlg) done(false); };
    form.addEventListener("submit", onSubmit);
    dlg.addEventListener("cancel", onCancel);
    dlg.addEventListener("close", onClose);
    dlg.addEventListener("click", onBackdrop);
  });
}

/* ---------- Messages ---------- */

let toastTimer = null;
export function toast(message, kind = "info") {
  const el = $("#toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
}

/** Bouton en attente : désactivé, avec un autre texte. Renvoie la fonction qui le rétablit. */
export function busy(button, label) {
  const old = button.innerHTML;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.innerHTML = old;
  };
}

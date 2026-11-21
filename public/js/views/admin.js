/*
 * Admin dans le Board : les écrans d'administration d'une instance, décrits par l'appli elle-même
 * (protocole kosmy.board-admin.v1, voir docs/admin-api.md). Le serveur du Board relaie, l'appli décide.
 * Tout ce qui vient de l'appli est affiché en texte brut (esc).
 */
import { api } from "../api.js";
import { state, titleHtml } from "../app.js";
import { errorText, lang, t } from "../i18n.js";
import { hostOf } from "../normalize.js";
import { $, $$, busy, confirmBox, esc, logoTile, toast } from "../ui.js";
import { openInTab, openUrl, windowName } from "./list.js";

/** Sommaire gardé le temps de la visite : changer de section ne le redemande pas. */
let cache = null; // { id, lang, manifest }
/** Valeur à montrer une seule fois (mot de passe temporaire, lien…), jusqu'au prochain changement de section. */
let reveal = null; // { key, label, value }
let seq = 0;

const base = (id) => `api/spaces/${encodeURIComponent(id)}/admin`;
const q = () => `?lang=${encodeURIComponent(lang)}`;

/** Message d'erreur : celui du Board, et celui de l'appli s'il y en a un. */
function adminError(ex) {
  const msg = ex.extra?.message;
  if (ex.code === "admin_app_error" && msg) return msg;
  return msg ? `${errorText(ex.code, ex.extra)} — ${msg}` : errorText(ex.code, ex.extra);
}

/* ---------- Champs ---------- */

function fieldHtml(f, prefix) {
  const fid = `${prefix}-${f.name}`;
  const common = `id="${esc(fid)}" name="${esc(f.name)}"${f.required ? " required" : ""}${f.readOnly ? " readonly" : ""}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""}${f.maxLength ? ` maxlength="${f.maxLength}"` : ""}`;
  const help = f.help ? `<span class="hint">${esc(f.help)}</span>` : "";
  const label = `<label class="mono" for="${esc(fid)}">${esc(f.label)}${f.required ? ` <span class="req" title="${esc(t("adminRequired"))}">*</span>` : ""}</label>`;
  if (f.type === "checkbox") {
    return `<div class="field check-field">
      <label class="check" for="${esc(fid)}"><input type="checkbox" id="${esc(fid)}" name="${esc(f.name)}"${f.value ? " checked" : ""}${f.readOnly ? " disabled" : ""}><span class="box" aria-hidden="true"></span><span>${esc(f.label)}</span></label>${help}</div>`;
  }
  let control;
  if (f.type === "textarea") {
    control = `<textarea class="input" rows="4" ${common}>${esc(f.value ?? "")}</textarea>`;
  } else if (f.type === "select") {
    control = `<select class="input" ${common}${f.readOnly ? " disabled" : ""}>${f.options.map((o) => `<option value="${esc(o.value)}"${o.value === f.value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
  } else {
    const type = f.type === "password" ? "password" : f.type;
    const num = f.type === "number" ? `${f.min !== undefined ? ` min="${f.min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""} step="${f.step ?? "any"}"` : "";
    const auto = f.type === "password" ? ' autocomplete="new-password"' : ' autocomplete="off"';
    control = `<input class="input" type="${type}" ${common}${num}${auto} spellcheck="false" value="${esc(f.value ?? "")}">`;
  }
  return `<div class="field">${label}${control}${help}</div>`;
}

/** Valeurs d'un formulaire, typées comme l'appli les attend (les champs en lecture seule ne partent pas). */
function readValues(form, fields) {
  const values = {};
  for (const f of fields) {
    if (f.readOnly) continue;
    const el = form.elements.namedItem(f.name);
    if (!el) continue;
    if (f.type === "checkbox") values[f.name] = el.checked;
    else if (f.type === "number") values[f.name] = el.value === "" ? "" : Number(el.value);
    else values[f.name] = el.value;
  }
  return values;
}

/* ---------- Petite boîte de saisie (action avec des champs) ---------- */

function fieldsDialog({ title, text, fields, ok, danger }) {
  let dlg = $("#admin-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "confirm admin-dialog";
    dlg.id = "admin-dialog";
    dlg.setAttribute("aria-labelledby", "admin-dialog-title");
    document.body.append(dlg);
  }
  dlg.innerHTML = `<form>
      <p class="mono confirm-kicker">Kosmy Board</p>
      <h2 class="serif confirm-title" id="admin-dialog-title">${esc(title)}</h2>
      ${text ? `<p class="confirm-text">${esc(text)}</p>` : ""}
      <div class="dialog-fields">${fields.map((f) => fieldHtml(f, "dlg")).join("")}</div>
      <div class="confirm-actions">
        <button class="btn ghost" type="button" data-cancel>${esc(t("cancel"))}</button>
        <button class="btn${danger ? " danger" : ""}" type="submit">${esc(ok)}</button>
      </div>
    </form>`;
  const form = $("form", dlg);
  dlg.showModal();
  $("input, select, textarea", dlg)?.focus();
  return new Promise((resolve) => {
    const done = (v) => {
      if (dlg.open) dlg.close();
      resolve(v);
    };
    form.addEventListener("submit", (e) => { e.preventDefault(); done(readValues(form, fields)); });
    $("[data-cancel]", dlg).addEventListener("click", () => done(null));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(null); }, { once: true });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) done(null); });
  });
}

/* ---------- Blocs ---------- */

const TONE_CLASS = { success: "ok", warning: "warn", danger: "bad", muted: "muted", info: "info" };

function cellHtml(v) {
  if (v === true || v === false) return `<span class="pill ${v ? "ok" : "muted"}">${esc(t(v ? "adminYes" : "adminNo"))}</span>`;
  if (v && typeof v === "object") {
    const inner = v.tone ? `<span class="pill ${TONE_CLASS[v.tone] ?? ""}">${esc(v.text)}</span>` : esc(v.text);
    return v.href ? `<a class="cell-link" href="${esc(v.href)}" target="_blank" rel="noopener noreferrer">${inner} <span aria-hidden="true">↗</span></a>` : inner;
  }
  return esc(v ?? "");
}
const cellText = (v) => (v && typeof v === "object" ? v.text : v === true ? t("adminYes") : v === false ? t("adminNo") : String(v ?? ""));

function blockHtml(b, i) {
  const title = b.title ? `<h3 class="serif block-title">${esc(b.title)}</h3>` : "";
  switch (b.type) {
    case "notice":
      return `<div class="a-block a-notice" data-tone="${esc(b.tone)}" role="${b.tone === "danger" || b.tone === "warning" ? "alert" : "note"}">
        ${b.title ? `<strong>${esc(b.title)}</strong>` : ""}${b.text ? `<p>${esc(b.text)}</p>` : ""}</div>`;
    case "stats":
      return `<div class="a-block">${title}<dl class="a-stats">${b.items.map((it) => `
        <div class="stat"><dt class="mono">${esc(it.label)}</dt><dd class="serif">${esc(it.value)}</dd>${it.hint ? `<dd class="hint">${esc(it.hint)}</dd>` : ""}</div>`).join("")}</dl></div>`;
    case "fields":
      return `<div class="a-block">${title}<dl class="settings a-fields">${b.items.map((it) => `
        <div class="setting"><dt class="mono label">${esc(it.label)}</dt><dd><code>${esc(it.value)}</code>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ""}</dd></div>`).join("")}</dl></div>`;
    case "form":
      return `<form class="a-block a-form" data-block="${i}">
        ${title}${b.description ? `<p class="note">${esc(b.description)}</p>` : ""}
        ${b.fields.map((f) => fieldHtml(f, `b${i}`)).join("")}
        <p class="error" role="alert" hidden></p>
        <div class="form-actions"><button class="btn signal" type="submit">${esc(b.submit || t("adminSubmit"))}</button></div>
      </form>`;
    case "table": {
      const byId = Object.fromEntries((b.rowActions ?? []).map((a) => [a.id, a]));
      const filter = b.rows.length > 10
        ? `<div class="field search a-filter"><label class="mono" for="flt-${i}">${esc(t("adminFilter"))}</label><input class="input" id="flt-${i}" type="search" data-filter="${i}" autocomplete="off" spellcheck="false" placeholder="${esc(t("adminFilterPlaceholder"))}"></div>`
        : "";
      const tools = b.actions?.length
        ? `<div class="a-tools">${b.actions.map((a) => `<button class="btn ghost sm${a.danger ? " danger-ghost" : ""}" type="button" data-block="${i}" data-action="${esc(a.id)}">${esc(a.label)}</button>`).join("")}</div>`
        : "";
      const rows = b.rows.map((r, ri) => {
        const first = cellText(r.cells[b.columns[0].key]);
        const acts = (r.actions ?? []).map((id) => byId[id]).filter(Boolean);
        return `<tr data-row="${ri}" data-search="${esc(b.columns.map((c) => cellText(r.cells[c.key])).join(" ").toLowerCase())}">
          ${b.columns.map((c, ci) => `<td data-label="${esc(c.label)}"${ci === 0 ? ' class="first"' : ""}>${cellHtml(r.cells[c.key])}</td>`).join("")}
          ${b.rowActions?.length ? `<td class="row-acts">${acts.length ? `<div class="row-actions" role="group" aria-label="${esc(t("adminRowActions", first))}">${acts.map((a) => `<button class="text-btn mono${a.danger ? " danger" : ""}" type="button" data-block="${i}" data-row="${ri}" data-action="${esc(a.id)}">${esc(a.label)}</button>`).join("")}</div>` : ""}</td>` : ""}
        </tr>`;
      }).join("");
      return `<div class="a-block a-table-wrap">
        <div class="a-table-head">${title}${filter}${tools}</div>
        ${b.description ? `<p class="note a-table-desc">${esc(b.description)}</p>` : ""}
        ${b.rows.length ? `<table class="a-table">
          <thead><tr>${b.columns.map((c) => `<th class="mono" scope="col">${esc(c.label)}</th>`).join("")}${b.rowActions?.length ? '<th class="row-acts"><span class="sr-only">Actions</span></th>' : ""}</tr></thead>
          <tbody>${rows}</tbody>
        </table><p class="no-match" data-nomatch="${i}" hidden>${esc(t("adminNoMatch"))}</p>` : `<p class="no-match">${esc(b.empty || t("adminNoRows"))}</p>`}
      </div>`;
    }
    case "actions":
      return `<div class="a-block">${title}<div class="a-actions">${b.items.map((a) => `
        <button type="button" class="a-action${a.danger ? " danger" : ""}" data-block="${i}" data-action="${esc(a.id)}">
          <strong>${esc(a.label)}</strong>${a.description ? `<span class="hint">${esc(a.description)}</span>` : ""}<span class="arrow" aria-hidden="true">→</span>
        </button>`).join("")}</div></div>`;
    default:
      return "";
  }
}

function revealHtml() {
  if (!reveal) return "";
  return `<div class="invite-link a-reveal" role="status">
    <span class="mono">${esc(reveal.label)} — ${esc(t("adminRevealOnce"))}</span>
    <code>${esc(reveal.value)}</code>
    <div><button class="text-btn mono" type="button" data-copy="${esc(reveal.value)}">${esc(t("copy2"))}</button></div>
  </div>`;
}

/* ---------- Page ---------- */

function sideHtml(space, manifest) {
  const app = space.appId ? state.catalog?.appById[space.appId] : null;
  const version = manifest?.app?.version ? ` · v${manifest.app.version}` : "";
  return `
    <div class="chosen">
      ${logoTile(app, space.name, "sm")}
      <span class="label">${esc(manifest?.app?.name || space.name)}<span class="mono host-line">${esc(hostOf(space.base))}${esc(version)}</span></span>
      <span class="tag-sso">${esc(t("ssoTag"))}</span>
    </div>
    ${manifest?.user ? `<p class="mono admin-as">${esc(t("adminAs", manifest.user.name, manifest.user.role))}</p>` : ""}
    <a class="link admin-open" href="${esc(openUrl(space, true))}" target="${windowName(space, true)}" rel="noopener noreferrer" data-open-app>${esc(t("adminOpenApp"))} ↗</a>`;
}

function headHtml(space, manifest) {
  return `
    <a class="back mono" href="#/">${esc(t("back"))}</a>
    <div class="admin-head">
      <div>
        <p class="mono kicker fade">${esc(t("adminKicker"))}</p>
        <h1 class="serif page-title">${titleHtml(t("adminTitle", esc(space.name)))}</h1>
      </div>
      <div class="admin-side fade" style="--d:.2s">${sideHtml(space, manifest)}</div>
    </div>`;
}

function navHtml(space, manifest, current) {
  return `<nav class="admin-nav" aria-label="${esc(t("adminSections"))}">
    ${manifest.sections.map((s) => `<a class="chip mono" href="#/admin/${encodeURIComponent(space.id)}/${encodeURIComponent(s.id)}"${s.id === current ? ' aria-current="page"' : ""}>${esc(s.title)}</a>`).join("")}
  </nav>`;
}

function errorPanel(space, ex) {
  const sso = ex.code === "admin_no_sso";
  return `<div class="empty admin-error" role="alert">
    <p class="mono">${esc(t("adminErrorTitle"))}</p>
    <p>${esc(errorText(ex.code, ex.extra))}</p>
    ${ex.extra?.message ? `<p class="note">${esc(t("adminAppSays"))} ${esc(ex.extra.message)}</p>` : ""}
    <div class="form-actions">
      ${sso ? `<a class="btn signal" href="#/connexion-unique/${encodeURIComponent(space.id)}">${esc(t("adminSsoLink"))}</a>`
        : `<button class="btn ghost" type="button" data-retry>${esc(t("adminRetry"))}</button>`}
      ${ex.code === "not_found" ? "" : `<a class="link" href="${esc(openUrl(space, true))}" target="${windowName(space, true)}" rel="noopener noreferrer" data-open-app>${esc(t("adminOpenApp"))} ↗</a>`}
    </div>
  </div>`;
}

export async function renderAdmin(main, { id, section }) {
  const mine = ++seq;
  const space = state.spaces?.find((s) => s.id === id);
  if (!space) {
    main.innerHTML = `<section class="page"><a class="back mono" href="#/">${esc(t("back"))}</a>
      <h1 class="serif page-title">${titleHtml(esc(t("notFound")))}</h1></section>`;
    return;
  }
  // L'en-tête n'est dessiné qu'une fois par espace et par langue : changer de section ne relance pas ses animations.
  const root = $(".admin-page", main);
  if (!root || root.dataset.space !== id || root.dataset.lang !== lang) {
    main.innerHTML = `<section class="page admin-page" data-space="${esc(id)}" data-lang="${esc(lang)}">
      ${headHtml(space, cache?.id === id && cache.lang === lang ? cache.manifest : null)}
      <div id="admin-nav" class="fade" style="--d:.3s"></div>
      <div class="admin-body" id="admin-body"><p class="mono boot">${esc(t("loading"))}</p></div>
      <p class="note admin-aside">${esc(t("adminAside"))}</p>
    </section>`;
    wireCommon(main, space);
  }
  const setBody = (html) => { $("#admin-body", main).innerHTML = html; };
  const fail = (ex, retry) => {
    if (mine !== seq) return;
    setBody(errorPanel(space, ex));
    if (retry) $("[data-retry]", main)?.addEventListener("click", retry);
    wireCommon(main, space);
  };

  if (!space.sso) return fail({ code: "admin_no_sso" });

  let manifest = cache?.id === id && cache.lang === lang ? cache.manifest : null;
  if (!manifest) {
    try {
      manifest = await api.get(base(id) + q());
    } catch (ex) {
      return fail(ex, () => {
        setBody(`<p class="mono boot">${esc(t("loading"))}</p>`);
        renderAdmin(main, { id, section });
      });
    }
    if (mine !== seq) return;
    cache = { id, lang, manifest };
    $(".admin-side", main).innerHTML = sideHtml(space, manifest);
    wireCommon(main, space);
  }

  const current = manifest.sections.some((s) => s.id === section) ? section : manifest.sections[0].id;
  if (reveal && reveal.key !== `${id}/${current}`) reveal = null;
  $("#admin-nav", main).innerHTML = navHtml(space, manifest, current);
  if (!$("#admin-body .boot", main)) setBody(`<p class="mono boot">${esc(t("loading"))}</p>`);

  let data;
  try {
    data = await api.get(`${base(id)}/${encodeURIComponent(current)}${q()}`);
  } catch (ex) {
    return fail(ex, () => renderAdmin(main, { id, section: current }));
  }
  if (mine !== seq) return;
  showSection(main, space, current, data);
}

function showSection(main, space, sectionId, data) {
  const body = $("#admin-body", main);
  if (!body) return;
  const key = `${space.id}/${sectionId}`;
  body.innerHTML = `
    ${data.title || data.description ? `<div class="admin-intro">${data.title ? `<h2 class="serif section-title">${esc(data.title)}</h2>` : ""}${data.description ? `<p class="lead">${esc(data.description)}</p>` : ""}</div>` : ""}
    ${revealHtml()}
    ${data.blocks.length ? data.blocks.map(blockHtml).join("") : `<p class="no-match">${esc(t("adminEmpty"))}</p>`}`;

  /** Envoie une action à l'appli, puis affiche la section à jour. */
  const run = async (payload, button, form) => {
    const restore = button ? busy(button, "…") : () => {};
    const errEl = form ? $(".error", form) : null;
    if (errEl) errEl.hidden = true;
    try {
      const r = await api.post(`${base(space.id)}/${encodeURIComponent(sectionId)}${q()}`, payload);
      reveal = r.reveal ? { key, ...r.reveal } : null;
      toast(r.message || t("adminDone"), r.tone === "danger" || r.tone === "warning" ? "error" : "info");
      let next = r.section;
      if (!next) next = await api.get(`${base(space.id)}/${encodeURIComponent(sectionId)}${q()}`);
      showSection(main, space, sectionId, next);
      if (reveal) $(".a-reveal", main)?.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (ex) {
      restore();
      if (errEl) {
        errEl.textContent = adminError(ex);
        errEl.hidden = false;
      } else toast(adminError(ex), "error");
    }
  };

  /** Une action décrite par l'appli : confirmation ou petit formulaire d'abord, si elle le demande. */
  const trigger = async (a, button, row) => {
    const label = row ? `${a.label} — ${row.label}` : a.label;
    let values;
    if (a.fields?.length) {
      values = await fieldsDialog({ title: label, text: a.confirm, fields: a.fields, ok: a.label, danger: a.danger });
      if (!values) return;
    } else if (a.confirm || a.danger) {
      const ok = await confirmBox({ title: `${label}${lang === "fr" ? " ?" : "?"}`, text: a.confirm ?? "", ok: a.label, danger: a.danger });
      if (!ok) return;
    }
    run({ action: a.id, ...(row ? { row: row.id } : {}), ...(values ? { values } : {}) }, button);
  };

  $$("form.a-form", body).forEach((form) => {
    const b = data.blocks[Number(form.dataset.block)];
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      run({ action: b.action, values: readValues(form, b.fields) }, $("button[type=submit]", form), form);
    });
  });

  body.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const b = data.blocks[Number(btn.dataset.block)];
    const aid = btn.dataset.action;
    if (b.type === "table" && btn.dataset.row !== undefined) {
      const r = b.rows[Number(btn.dataset.row)];
      const a = b.rowActions.find((x) => x.id === aid);
      if (r && a) trigger(a, btn, { id: r.id, label: cellText(r.cells[b.columns[0].key]) });
    } else {
      const a = (b.type === "table" ? b.actions : b.items)?.find((x) => x.id === aid);
      if (a) trigger(a, btn);
    }
  });

  $$("input[data-filter]", body).forEach((input) => {
    const i = input.dataset.filter;
    const wrap = input.closest(".a-table-wrap");
    input.addEventListener("input", () => {
      const v = input.value.trim().toLowerCase();
      let n = 0;
      for (const tr of $$("tbody tr", wrap)) {
        const show = !v || tr.dataset.search.includes(v);
        tr.hidden = !show;
        if (show) n++;
      }
      $(`[data-nomatch="${i}"]`, wrap).hidden = n > 0;
    });
  });
}

/** « Ouvrir l'admin de l'appli » : le même onglet que le bouton « Admin » d'avant, avec la connexion unique. */
function wireCommon(main, space) {
  $$("[data-open-app]:not([data-wired])", main).forEach((a) => {
    a.dataset.wired = "";
    a.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      openInTab(openUrl(space, true), windowName(space, true));
    });
  });
}

/* Ajouter ou modifier un espace : choisir l'appli, saisir l'adresse, voir l'adresse finale. */
import { api } from "../api.js";
import { go, state, titleHtml } from "../app.js";
import { errorText, lang, t } from "../i18n.js";
import { hostOf, isCleartext, isLocalHost, normalizeBase, normalizePath, spaceUrl } from "../normalize.js";
import { probe } from "../status.js";
import { $, busy, colorsOf, confirmBox, esc, logoTile, toast } from "../ui.js";

const OTHER = "autre";
/** Brouillon gardé tant qu'on reste sur la même page (il survit au changement de langue). */
let draft = null;

function draftFor(key, editing, appId) {
  if (draft?.key === key) return draft;
  const app = appId && appId !== OTHER ? state.catalog?.appById[appId] : null;
  draft = editing
    ? { key, choice: editing.appId && state.catalog?.appById[editing.appId] ? editing.appId : OTHER, name: editing.name, address: editing.base, path: editing.path, unreachable: false }
    : { key, choice: app?.admin ? app.id : appId === OTHER ? OTHER : null, name: "", address: "", path: app?.admin?.path ?? "", unreachable: false };
  return draft;
}

export function renderEdit(main, { id, appId }) {
  const editing = id ? state.spaces?.find((s) => s.id === id) : null;
  if (id && !editing) {
    main.innerHTML = `<section class="page"><a class="back mono" href="#/">${esc(t("back"))}</a>
      <h1 class="serif page-title">${titleHtml(esc(t("notFound")))}</h1></section>`;
    return;
  }
  const d = draftFor(location.hash, editing, appId);
  const app = d.choice && d.choice !== OTHER ? state.catalog?.appById[d.choice] : null;
  const appName = d.choice === OTHER ? t("yourApp") : app?.name ?? "";

  const title = d.choice ? t("whereIs", esc(appName)) : t("whichApp");
  const options = (state.catalog?.apps ?? []).filter((a) => a.admin);

  const picker = `
    <div class="picker fade" style="--d:.3s">
      ${options.map((a) => {
        const { c, ink } = colorsOf(a);
        return `<button class="pick" type="button" data-pick="${esc(a.id)}" style="--c:${c};--ink:${ink}">
          ${logoTile(a, a.name, "sm")}
          <span><span class="serif">${esc(a.name)}</span><span class="line">${esc(a.text[lang]?.line ?? a.text.fr.line)}</span></span>
          <span class="arrow" aria-hidden="true">→</span>
        </button>`;
      }).join("")}
      <button class="pick" type="button" data-pick="${OTHER}" style="--c:#c5f04a;--ink:#0d0c0a">
        ${logoTile(null, "+", "sm")}
        <span><span class="serif">${t("otherTitle")}</span><span class="line">${esc(t("otherText"))}</span></span>
        <span class="arrow" aria-hidden="true">→</span>
      </button>
    </div>`;

  const form = `
    <form class="fade" style="--d:.2s" novalidate>
      <div class="chosen">
        ${logoTile(app, d.choice === OTHER ? d.name || "?" : app?.name, "sm")}
        <span class="label">${esc(d.choice === OTHER ? t("otherApp") : app?.name)}</span>
        ${editing ? "" : `<button class="text-btn mono" type="button" id="change">${esc(t("change"))}</button>`}
      </div>
      <div class="field">
        <label class="mono" for="f-address">${esc(t("fieldAddress"))}</label>
        <input class="input" id="f-address" type="url" inputmode="url" autocomplete="url" spellcheck="false" autocapitalize="off" required
          placeholder="${esc(app ? `https://${app.id}.mondomaine.fr` : "https://monappli.mondomaine.fr")}" value="${esc(d.address)}">
      </div>
      <div class="field">
        <label class="mono" for="f-path">${esc(t("fieldPath"))}</label>
        <input class="input" id="f-path" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${esc(app?.admin?.path ?? "/")}" value="${esc(d.path)}">
        ${app ? `<span class="hint">${esc(t("pathHint", app.name))}</span>` : ""}
      </div>
      <div class="field">
        <label class="mono" for="f-name">${esc(t("fieldName"))}</label>
        <input class="input" id="f-name" type="text" autocomplete="off" maxlength="80" ${d.choice === OTHER ? "required" : ""}
          placeholder="${esc(app?.name ?? t("fieldNamePlaceholder"))}" value="${esc(d.name)}">
        ${app ? `<span class="hint">${esc(t("fieldNameHint"))}</span>` : ""}
      </div>
      <div class="preview" id="preview" hidden><p class="mono">${esc(t("preview"))}</p><p class="url" id="preview-url"></p></div>
      <p class="warn" id="clear-warn" hidden></p>
      <p class="error" id="form-error" role="alert" hidden></p>
      <p class="warn" id="unreachable" role="alert" hidden>${esc(t("unreachable"))}</p>
      <div class="form-actions">
        <button class="btn signal" type="submit" id="save"></button>
        <a class="link" href="#/">${esc(t("cancel"))}</a>
      </div>
      ${editing ? `<div class="danger-zone"><button type="button" id="delete"><strong>${esc(t("removeSpace"))}</strong><span class="mono">${esc(t("removeSpaceHint"))}</span></button></div>` : ""}
    </form>`;

  main.innerHTML = `
    <section class="page edit">
      <div>
        <a class="back mono" href="#/">${esc(t("back"))}</a>
        <p class="mono kicker fade">${esc(t(editing ? "editKicker" : "newKicker"))}</p>
        <h1 class="serif page-title" style="margin-bottom:40px">${titleHtml(title)}</h1>
        ${d.choice ? form : picker}
      </div>
      <aside class="edit-aside fade" style="--d:.4s">
        ${app ? `<p class="mono kicker" style="margin:0">${esc(state.catalog.themeById[app.theme]?.name[lang] ?? "")}</p><p class="lead">${esc(app.text[lang]?.more ?? "")}</p>` : ""}
        <p class="lead">${esc(t("editAside"))}</p>
      </aside>
    </section>`;

  if (!d.choice) {
    main.querySelector(".picker").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (!b) return;
      const picked = b.dataset.pick;
      const a = picked === OTHER ? null : state.catalog.appById[picked];
      Object.assign(d, { choice: picked, path: a?.admin?.path ?? "", unreachable: false });
      renderEdit(main, { id, appId });
      $("#f-address", main)?.focus();
    });
    return;
  }

  const els = {
    address: $("#f-address", main), path: $("#f-path", main), name: $("#f-name", main),
    preview: $("#preview", main), previewUrl: $("#preview-url", main), clear: $("#clear-warn", main),
    error: $("#form-error", main), unreachable: $("#unreachable", main), save: $("#save", main),
  };

  const compute = () => {
    const n = normalizeBase(d.address, app?.admin?.path);
    const path = normalizePath(d.path || app?.admin?.path || "/");
    return { n, path, url: "base" in n && path ? spaceUrl({ base: n.base, path }) : null };
  };

  const refresh = () => {
    const { url } = compute();
    els.preview.hidden = !url;
    if (url) els.previewUrl.textContent = url;
    const http = url && isCleartext(url);
    const local = http && isLocalHost(hostOf(url));
    els.clear.hidden = !http;
    els.clear.className = local ? "note" : "warn";
    els.clear.textContent = http ? t(local ? "cleartextLocal" : "cleartextWarning") : "";
    els.unreachable.hidden = !d.unreachable;
    els.save.textContent = d.unreachable ? t("saveAnyway") : editing ? t("save") : t("addSpace");
  };
  refresh();

  const showError = (code, extra, focus) => {
    els.error.textContent = errorText(code, extra);
    els.error.hidden = false;
    focus?.focus();
  };

  for (const [key, el] of [["address", els.address], ["path", els.path], ["name", els.name]]) {
    el.addEventListener("input", () => {
      d[key] = el.value;
      if (key !== "name") d.unreachable = false;
      els.error.hidden = true;
      refresh();
    });
  }

  $("#change", main)?.addEventListener("click", () => {
    Object.assign(d, { choice: null, unreachable: false });
    renderEdit(main, { id, appId });
  });

  $("form", main).addEventListener("submit", async (e) => {
    e.preventDefault();
    els.error.hidden = true;
    const name = d.name.trim() || (app?.name ?? "");
    if (!name) return showError("name", {}, els.name);
    const { n, path } = compute();
    if ("error" in n) return showError(n.error, {}, els.address);
    if (!path) return showError("path", {}, els.path);
    const input = { appId: app ? app.id : null, name, base: n.base, path };

    // Première tentative : on vérifie que l'adresse répond. La seconde enregistre quand même.
    const restore = busy(els.save, t("checking"));
    if (!d.unreachable && (await probe(spaceUrl(input))) === "down") {
      restore();
      d.unreachable = true;
      refresh();
      return;
    }
    try {
      if (editing) {
        const { space } = await api.put(`api/spaces/${encodeURIComponent(editing.id)}`, input);
        state.spaces = state.spaces.map((s) => (s.id === space.id ? space : s));
        toast(t("saved"));
      } else {
        const { space } = await api.post("api/spaces", input);
        state.spaces = [space, ...state.spaces];
        toast(t("added", space.name));
      }
      draft = null;
      go("#/");
    } catch (ex) {
      restore();
      refresh();
      showError(ex.code, ex.extra);
    }
  });

  $("#delete", main)?.addEventListener("click", async () => {
    const ok = await confirmBox({ title: t("removeTitle", editing.name), text: t("removeText"), ok: t("remove"), danger: true });
    if (!ok) return;
    try {
      await api.del(`api/spaces/${encodeURIComponent(editing.id)}`);
      state.spaces = state.spaces.filter((s) => s.id !== editing.id);
      toast(t("removed", editing.name));
      draft = null;
      go("#/");
    } catch (ex) {
      showError(ex.code, ex.extra);
    }
  });
}

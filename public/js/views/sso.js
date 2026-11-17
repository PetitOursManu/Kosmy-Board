/* Connexion unique d'un espace : relier l'instance au Board (OpenID Connect) et afficher les réglages à coller dans l'appli. */
import { api } from "../api.js";
import { refreshSpaces, state, titleHtml } from "../app.js";
import { errorText, t } from "../i18n.js";
import { $, busy, confirmBox, esc, logoTile, toast } from "../ui.js";

/** Le secret n'est montré qu'une fois : on le garde le temps de la page. */
let shownSecret = null;

const copyRow = (label, value, { secret = false, note = "" } = {}) => `
  <div class="setting${secret ? " secret" : ""}">
    <span class="mono label">${esc(label)}</span>
    <code>${esc(value)}</code>
    <button class="text-btn mono" type="button" data-copy="${esc(value)}">${esc(t("copy2"))}</button>
    ${note ? `<span class="hint">${esc(note)}</span>` : ""}
  </div>`;

function uriFields(info, values) {
  return `
    <div class="field">
      <label class="mono" for="sso-redirect">${esc(t("ssoRedirect"))}</label>
      <textarea class="input" id="sso-redirect" rows="2" spellcheck="false" autocapitalize="off" required
        placeholder="https://monappli.mondomaine.fr/auth/callback">${esc(values.redirectUris.join("\n"))}</textarea>
      <span class="hint">${esc(info.defaults ? t("ssoRedirectKosmy") : t("ssoRedirectHint"))}</span>
    </div>
    <div class="field">
      <label class="mono" for="sso-initiate">${esc(t("ssoInitiate"))}</label>
      <input class="input" id="sso-initiate" type="url" spellcheck="false" autocapitalize="off" value="${esc(values.initiateLoginUri ?? "")}">
      <span class="hint">${esc(t("ssoInitiateHint"))}</span>
    </div>
    <div class="field">
      <label class="mono" for="sso-method">${esc(t("ssoMethod"))}</label>
      <select class="input" id="sso-method">
        <option value="client_secret_basic"${values.authMethod !== "client_secret_post" ? " selected" : ""}>${esc(t("ssoMethodBasic"))}</option>
        <option value="client_secret_post"${values.authMethod === "client_secret_post" ? " selected" : ""}>${esc(t("ssoMethodPost"))}</option>
      </select>
    </div>`;
}

const readUris = (main) => ({
  redirectUris: $("#sso-redirect", main).value.split(/\s+/).filter(Boolean),
  initiateLoginUri: $("#sso-initiate", main).value.trim(),
  authMethod: $("#sso-method", main).value,
});

export async function renderSso(main, { id }) {
  const space = state.spaces?.find((s) => s.id === id);
  if (!space) {
    main.innerHTML = `<section class="page"><a class="back mono" href="#/">${esc(t("back"))}</a>
      <h1 class="serif page-title">${titleHtml(esc(t("notFound")))}</h1></section>`;
    return;
  }
  let info;
  try {
    info = await api.get(`api/spaces/${encodeURIComponent(id)}/sso`);
  } catch (ex) {
    toast(errorText(ex.code, ex.extra), "error");
    return;
  }
  if (!info.enabled || shownSecret?.id !== id) shownSecret = info.enabled && shownSecret?.id === id ? shownSecret : null;
  const app = space.appId ? state.catalog?.appById[space.appId] : null;
  const name = space.name;

  let body;
  if (info.enabled) {
    const secretRow = shownSecret?.id === id
      ? copyRow(t("ssoSecret"), shownSecret.value, { secret: true, note: t("ssoSecretOnce") })
      : `<div class="setting"><span class="mono label">${esc(t("ssoSecret"))}</span><code class="muted">••••••••••••••••</code><span></span><span class="hint">${esc(t("ssoSecretHidden"))}</span></div>`;
    body = `
      <h2 class="serif section-title">${esc(t("ssoSettings", name))}</h2>
      <div class="settings">
        ${copyRow(t("ssoIssuer"), info.issuer)}
        ${copyRow(t("ssoDiscovery"), info.discovery)}
        ${copyRow(t("ssoClientId"), info.clientId)}
        ${secretRow}
        ${copyRow(t("ssoScopes"), "openid profile email")}
      </div>
      <p class="note">${esc(t("ssoShared", info.sharedWith))}</p>
      ${info.canManage ? `
        <form id="sso-edit" novalidate>
          ${uriFields(info, info)}
          <p class="error" role="alert" hidden></p>
          <div class="form-actions">
            <button class="btn ghost" type="submit">${esc(t("ssoSave"))}</button>
            <button class="btn ghost" type="button" id="sso-rotate">${esc(t("ssoRotate"))}</button>
          </div>
        </form>` : `<p class="note">${esc(t("ssoNotManager"))}</p>
          <div class="settings">${info.redirectUris.map((u) => copyRow(t("ssoRedirect"), u)).join("")}</div>`}
      <div class="danger-zone"><button type="button" id="sso-off"><strong>${esc(t("ssoDisable"))}</strong><span class="mono">${esc(t("ssoDisableHint"))}</span></button></div>`;
  } else if (info.existing) {
    body = `<p class="lead">${esc(t("ssoExisting"))}</p>
      <p class="error" id="form-error" role="alert" hidden></p>
      <div class="form-actions"><button class="btn signal" type="button" id="sso-join">${esc(t("ssoJoin"))}</button></div>`;
  } else {
    const values = {
      redirectUris: info.defaults ? [info.defaults.redirectUri] : [],
      initiateLoginUri: info.defaults?.initiateLoginUri ?? "",
      authMethod: "client_secret_basic",
    };
    body = `<form id="sso-on" novalidate>
      ${uriFields(info, values)}
      <p class="error" role="alert" hidden></p>
      <div class="form-actions"><button class="btn signal" type="submit">${esc(t("ssoEnable"))}</button></div>
    </form>`;
  }

  main.innerHTML = `
    <section class="page edit sso">
      <div>
        <a class="back mono" href="#/modifier/${encodeURIComponent(id)}">← ${esc(t("ssoEdit"))}</a>
        <p class="mono kicker fade">${esc(t("ssoKicker"))}</p>
        <h1 class="serif page-title" style="margin-bottom:28px">${titleHtml(t("ssoTitle", esc(name)))}</h1>
        <div class="chosen fade" style="--d:.15s;margin-bottom:8px">
          ${logoTile(app, name, "sm")}
          <span class="label">${esc(name)}<span class="mono host-line">${esc(space.base)}</span></span>
          ${info.enabled ? `<span class="tag-sso">${esc(t("ssoTag"))}</span>` : ""}
        </div>
        <div class="fade" style="--d:.25s">${body}</div>
      </div>
      <aside class="edit-aside fade" style="--d:.4s">
        <p class="lead">${esc(t("ssoText", name))}</p>
        <p class="lead">${esc(t("ssoAside"))}</p>
      </aside>
    </section>`;

  const formError = (form, ex) => {
    const p = $(".error", form);
    p.textContent = errorText(ex.code, ex.extra);
    p.hidden = false;
  };
  const after = async (message) => {
    await refreshSpaces().catch(() => {});
    if (message) toast(message);
    renderSso(main, { id });
  };

  $("#sso-on", main)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const restore = busy($("button[type=submit]", form), "…");
    try {
      const r = await api.post(`api/spaces/${encodeURIComponent(id)}/sso`, readUris(main));
      if (r.secret) shownSecret = { id, value: r.secret };
      await after(t("ssoEnabled"));
    } catch (ex) {
      restore();
      formError(form, ex);
    }
  });

  $("#sso-join", main)?.addEventListener("click", async (e) => {
    const restore = busy(e.currentTarget, "…");
    try {
      await api.post(`api/spaces/${encodeURIComponent(id)}/sso`, {});
      await after(t("ssoEnabled"));
    } catch (ex) {
      restore();
      const p = $("#form-error", main);
      p.textContent = errorText(ex.code, ex.extra);
      p.hidden = false;
    }
  });

  $("#sso-edit", main)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    $(".error", form).hidden = true;
    const restore = busy($("button[type=submit]", form), "…");
    try {
      await api.put(`api/spaces/${encodeURIComponent(id)}/sso`, readUris(main));
      await after(t("ssoSaved"));
    } catch (ex) {
      restore();
      formError(form, ex);
    }
  });

  $("#sso-rotate", main)?.addEventListener("click", async () => {
    if (!(await confirmBox({ title: t("ssoRotateTitle"), text: t("ssoRotateText"), ok: t("ssoRotate") }))) return;
    try {
      const r = await api.post(`api/spaces/${encodeURIComponent(id)}/sso/secret`);
      shownSecret = { id, value: r.secret };
      await after();
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    }
  });

  $("#sso-off", main)?.addEventListener("click", async () => {
    if (!(await confirmBox({ title: t("ssoDisableTitle"), text: t("ssoDisableText"), ok: t("ssoDisable"), danger: true }))) return;
    try {
      await api.del(`api/spaces/${encodeURIComponent(id)}/sso`);
      shownSecret = null;
      await after(t("ssoDisabled"));
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    }
  });
}

/* Boutons « Copier » (un seul écouteur pour toute l'interface). */
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-copy]");
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => toast(t("copiedShort"))).catch(() => {});
});

/* Connexion (avec double authentification), première configuration, invitation, et mot de passe choisi par lien. */
import { api } from "../api.js";
import { go, reloadState, route, state, titleHtml } from "../app.js";
import { errorText, lang, setLang, initialLang, t } from "../i18n.js";
import { $, busy, esc } from "../ui.js";

const PASSWORD_MIN = 10;

function field({ id, label, type = "text", autocomplete, hint, value = "", attrs = "" }) {
  return `<div class="field">
    <label class="mono" for="${id}">${esc(label)}</label>
    <input class="input" id="${id}" name="${id}" type="${type}" autocomplete="${autocomplete}" value="${esc(value)}" ${attrs}>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ""}
  </div>`;
}

/** Connexion réussie : vers l'appli qui attendait (connexion unique), ou vers le Board. */
async function signedIn(mode, back) {
  const s = await reloadState();
  setLang(initialLang(s.user?.lang));
  if (back) location.replace(back);
  else if (mode === "invite" || mode === "password") go("#/");
  else route();
}

/**
 * mode : login, setup, invite, 2fa.
 * opts.back : étape de connexion unique où revenir ; opts.app : nom de l'appli qui attend ; opts.ticket : étape du code.
 */
export async function renderAuth(main, mode, inviteToken, opts = {}) {
  const { back = null, app = null } = opts;
  let inviteValid = true;
  let link = null;
  if (mode === "invite") {
    inviteValid = await api.post("api/invites/check", { token: inviteToken }).then((r) => r.valid).catch(() => false);
  } else if (mode === "password") {
    link = await api.post("api/password-links/check", { token: inviteToken }).catch(() => ({ valid: false }));
    inviteValid = link.valid;
  }
  const k = { login: "login", setup: "setup", invite: "invite", "2fa": "twoFactor", password: link?.activation === false ? "reset" : "activate" }[mode];

  let form;
  if (mode === "login") {
    form = `
      ${field({ id: "email", label: t("email"), type: "email", autocomplete: "username", attrs: "required autofocus inputmode=\"email\"" })}
      ${field({ id: "password", label: t("password"), type: "password", autocomplete: "current-password", attrs: "required" })}
      <p class="error" id="form-error" role="alert" hidden></p>
      <button class="btn signal" type="submit">${esc(t("signIn"))}</button>`;
  } else if (mode === "2fa") {
    form = `
      ${field({ id: "code", label: t("code"), autocomplete: "one-time-code", attrs: "required autofocus inputmode=\"numeric\" spellcheck=\"false\" autocapitalize=\"characters\" maxlength=\"12\"" })}
      <p class="error" id="form-error" role="alert" hidden></p>
      <button class="btn signal" type="submit">${esc(t("verify"))}</button>`;
  } else if (mode === "setup") {
    form = `
      ${field({ id: "code", label: t("setupCode"), autocomplete: "off", hint: t("setupCodeHint"), attrs: "required autofocus spellcheck=\"false\" autocapitalize=\"characters\"" })}
      ${field({ id: "name", label: t("name"), autocomplete: "name", attrs: "required maxlength=\"80\"" })}
      ${field({ id: "email", label: t("email"), type: "email", autocomplete: "username", attrs: "required inputmode=\"email\"" })}
      ${field({ id: "password", label: t("password"), type: "password", autocomplete: "new-password", hint: t("passwordHint", PASSWORD_MIN), attrs: `required minlength="${PASSWORD_MIN}"` })}
      <p class="error" id="form-error" role="alert" hidden></p>
      <button class="btn signal" type="submit">${esc(t("createAdmin"))}</button>`;
  } else if (mode === "password" && inviteValid) {
    form = `
      <p class="mono kicker">${esc(t("passwordFor", link.email))}</p>
      <input type="text" name="username" autocomplete="username" value="${esc(link.email)}" hidden>
      ${field({ id: "password", label: t("password"), type: "password", autocomplete: "new-password", hint: t("passwordHint", PASSWORD_MIN), attrs: `required autofocus minlength="${PASSWORD_MIN}"` })}
      <p class="error" id="form-error" role="alert" hidden></p>
      <button class="btn signal" type="submit">${esc(t("activateBtn"))}</button>`;
  } else if (mode === "password") {
    form = `<p class="lead">${esc(t("linkInvalid"))}</p>
      <a class="btn ghost" href="#/" style="margin-top:28px">${esc(t("toLogin"))}</a>`;
  } else if (inviteValid) {
    form = `
      ${field({ id: "name", label: t("name"), autocomplete: "name", attrs: "required autofocus maxlength=\"80\"" })}
      ${field({ id: "email", label: t("email"), type: "email", autocomplete: "username", attrs: "required inputmode=\"email\"" })}
      ${field({ id: "password", label: t("password"), type: "password", autocomplete: "new-password", hint: t("passwordHint", PASSWORD_MIN), attrs: `required minlength="${PASSWORD_MIN}"` })}
      <p class="error" id="form-error" role="alert" hidden></p>
      <button class="btn signal" type="submit">${esc(t("createAccount"))}</button>`;
  } else {
    form = `<p class="lead">${esc(t("inviteInvalid"))}</p>
      <a class="btn ghost" href="#/" style="margin-top:28px">${esc(t("toLogin"))}</a>`;
  }

  const waiting = app && (mode === "login" || mode === "2fa") ? `<p class="mono kicker continue">${esc(t("continueTo", app))}</p>` : "";

  main.innerHTML = `
    <section class="page auth">
      <div>
        <p class="mono kicker fade">${esc(t(`${k}Kicker`))}</p>
        <h1 class="serif page-title">${titleHtml(t(`${k}Title`))}</h1>
        <p class="lead fade" style="--d:.4s;margin-top:32px">${esc(t(`${k}Text`))}</p>
      </div>
      <form class="auth-form fade" style="--d:.25s" novalidate>${waiting}${form}</form>
    </section>`;

  const el = $("form", main);
  el.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#form-error", main);
    if (!err) return;
    err.hidden = true;
    const data = Object.fromEntries(new FormData(el));
    const button = $("button[type=submit]", el);
    const restore = busy(button, t("signingIn"));
    try {
      if (mode === "login") {
        const r = await api.post("api/login", { email: data.email, password: data.password });
        if (r.twoFactor) return renderAuth(main, "2fa", null, { ...opts, ticket: r.ticket });
      } else if (mode === "2fa") {
        await api.post("api/login/2fa", { ticket: opts.ticket, code: data.code });
      } else if (mode === "setup") {
        await api.post("api/setup", { ...data, lang });
      } else if (mode === "password") {
        await api.post("api/password-links/accept", { token: inviteToken, password: data.password });
      } else {
        await api.post("api/invites/accept", { ...data, token: inviteToken, lang });
      }
      await signedIn(mode, back);
    } catch (ex) {
      restore();
      if (ex.code === "already_setup") {
        state.setupNeeded = false;
        return renderAuth(main, "login", null, opts);
      }
      if (ex.code === "ticket") return renderAuth(main, "login", null, { back, app });
      err.textContent = errorText(ex.code, ex.extra);
      err.hidden = false;
      const focus = { setup_code: "code", code: "code", email: "email", email_taken: "email", name: "name", password_short: "password", login_failed: "password" }[ex.code];
      const input = focus && $(`#${focus}`, el);
      if (input) {
        input.focus();
        if (ex.code === "code") input.select();
      }
    }
  });
}

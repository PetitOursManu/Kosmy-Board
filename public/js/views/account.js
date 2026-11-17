/* Compte : profil, mot de passe, sauvegarde (export / import), membres et invitations, déconnexion du Board. */
import { api } from "../api.js";
import { reloadState, refreshSpaces, route, state, titleHtml } from "../app.js";
import { errorText, relTime, t } from "../i18n.js";
import { $, busy, confirmBox, esc, toast } from "../ui.js";

const PASSWORD_MIN = 10;

const section = (n, title, body, lead = "") => `
  <div class="section">
    <div><span class="num mono">(${n})</span><h2 class="serif">${title}</h2>${lead ? `<p class="lead" style="margin-top:14px">${esc(lead)}</p>` : ""}</div>
    <div class="section-body">${body}</div>
  </div>`;

function peopleHtml(data) {
  const me = state.user.id;
  return `<div class="people">
    ${data.users.map((u) => `
      <div class="person">
        <span class="avatar" aria-hidden="true">${esc((u.name.trim()[0] || "?").toUpperCase())}</span>
        <span class="who"><strong>${esc(u.name)}${u.id === me ? ` <span class="mono" style="display:inline;color:var(--signal)">· ${esc(t("you"))}</span>` : ""}</strong>
          <span class="mono">${esc(u.email)} · ${esc(t(u.role === "admin" ? "roleAdmin" : "roleMember"))} · ${esc(t("spacesCount", u.spaces))}</span></span>
        ${u.id === me ? "<span></span>" : `<button class="text-btn mono danger" type="button" data-remove-user="${esc(u.id)}" data-name="${esc(u.name)}">${esc(t("removeMember"))}</button>`}
      </div>`).join("")}
    ${data.invites.map((i) => `
      <div class="person pending">
        <span class="avatar" aria-hidden="true">+</span>
        <span class="who"><strong>${esc(t(i.role === "admin" ? "roleAdmin" : "roleMember"))}</strong><span class="mono">${esc(t("pendingInvite", relTime(i.expiresAt)))}</span></span>
        <button class="text-btn mono danger" type="button" data-revoke="${esc(i.id)}">${esc(t("revoke"))}</button>
      </div>`).join("")}
  </div>`;
}

/* ---------- Double authentification ---------- */

function codesHtml(codes) {
  return `
    <div class="recovery">
      <p class="mono label">${esc(t("recoveryTitle"))}</p>
      <p class="hint">${esc(t("recoveryText"))}</p>
      <ul class="codes mono">${codes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      <div class="inline-actions">
        <button class="btn ghost" type="button" data-copy="${esc(codes.join("\n"))}">${esc(t("copy2"))}</button>
        <button class="btn ghost" type="button" id="tfa-download">${esc(t("recoveryDownload"))} ↓</button>
        <button class="btn signal" type="button" id="tfa-done">${esc(t("recoveryDone"))}</button>
      </div>
    </div>`;
}

const confirmFields = (u) => `
  <p class="mono label" style="margin-top:20px">${esc(t("twoFactorConfirmTitle"))}</p>
  <input type="text" name="username" autocomplete="username" value="${esc(u.email)}" hidden>
  <div class="field"><label class="mono" for="tfa-pw">${esc(t("currentPassword"))}</label>
    <input class="input" id="tfa-pw" type="password" autocomplete="current-password" required></div>
  <div class="field"><label class="mono" for="tfa-code">${esc(t("code"))}</label>
    <input class="input" id="tfa-code" autocomplete="one-time-code" inputmode="numeric" spellcheck="false" maxlength="12" required></div>`;

/** États : off, setup (QR code), codes (codes de secours à noter), on, confirm-disable, confirm-recovery. */
async function renderTfa(box, mode, main, data = {}) {
  const u = state.user;
  const err = `<p class="error" role="alert" hidden></p>`;
  const showError = (ex) => {
    const p = $(".error", box);
    p.textContent = errorText(ex.code, ex.extra);
    p.hidden = false;
  };

  if (mode === "off") {
    box.innerHTML = `<button class="btn signal" type="button" id="tfa-start">${esc(t("twoFactorStart"))}</button>${err}`;
    $("#tfa-start", box).addEventListener("click", async (e) => {
      const restore = busy(e.currentTarget, "…");
      try {
        renderTfa(box, "setup", main, await api.post("api/2fa/setup"));
      } catch (ex) {
        restore();
        showError(ex);
      }
    });
  } else if (mode === "setup") {
    // Le QR code est un SVG produit par le serveur du Board (bibliothèque qrcode), pas une donnée saisie.
    box.innerHTML = `
      <p class="hint">${esc(t("twoFactorScan"))}</p>
      <div class="qr">${data.qr}</div>
      <div class="setting"><span class="mono label">${esc(t("twoFactorKey"))}</span><code>${esc(data.secret.replace(/(.{4})/g, "$1 ").trim())}</code>
        <button class="text-btn mono" type="button" data-copy="${esc(data.secret)}">${esc(t("copy2"))}</button></div>
      <form id="tfa-enable" novalidate>
        <div class="field"><label class="mono" for="tfa-first">${esc(t("code"))}</label>
          <input class="input" id="tfa-first" autocomplete="one-time-code" inputmode="numeric" maxlength="6" required></div>
        ${err}
        <button class="btn signal" type="submit">${esc(t("twoFactorConfirm"))}</button>
      </form>`;
    $("#tfa-first", box).focus();
    $("#tfa-enable", box).addEventListener("submit", async (e) => {
      e.preventDefault();
      const restore = busy($("button[type=submit]", box), "…");
      try {
        const r = await api.post("api/2fa/enable", { code: $("#tfa-first", box).value });
        state.user.totp = true;
        toast(t("twoFactorEnabledToast"));
        renderTfa(box, "codes", main, { codes: r.recoveryCodes });
      } catch (ex) {
        restore();
        showError(ex);
      }
    });
  } else if (mode === "codes") {
    box.innerHTML = codesHtml(data.codes);
    const lead = box.closest(".section")?.querySelector(".lead");
    if (lead) lead.textContent = t("twoFactorOn", data.codes.length);
    $("#tfa-download", box).addEventListener("click", () => {
      const text = `Kosmy Board — ${u.email}\n${location.origin}\n\n${data.codes.join("\n")}\n`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = "kosmy-board-codes-de-secours.txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $("#tfa-done", box).addEventListener("click", () => renderAccount(main));
  } else if (mode === "on") {
    box.innerHTML = `<div class="inline-actions">
      <button class="btn ghost" type="button" id="tfa-recovery">${esc(t("recoveryNew"))}</button>
      <button class="btn ghost" type="button" id="tfa-off">${esc(t("twoFactorDisable"))}</button></div>`;
    $("#tfa-recovery", box).addEventListener("click", () => renderTfa(box, "confirm-recovery", main));
    $("#tfa-off", box).addEventListener("click", () => renderTfa(box, "confirm-disable", main));
  } else {
    const disable = mode === "confirm-disable";
    box.innerHTML = `<form id="tfa-confirm" novalidate>${confirmFields(u)}${err}
      <div class="inline-actions">
        <button class="btn ${disable ? "danger" : "signal"}" type="submit">${esc(disable ? t("twoFactorDisable") : t("recoveryNew"))}</button>
        <button class="btn ghost" type="button" id="tfa-cancel">${esc(t("cancel"))}</button>
      </div></form>`;
    $("#tfa-pw", box).focus();
    $("#tfa-cancel", box).addEventListener("click", () => renderTfa(box, "on", main));
    $("#tfa-confirm", box).addEventListener("submit", async (e) => {
      e.preventDefault();
      const restore = busy($("button[type=submit]", box), "…");
      const body = { password: $("#tfa-pw", box).value, code: $("#tfa-code", box).value };
      try {
        if (disable) {
          await api.post("api/2fa/disable", body);
          state.user.totp = false;
          toast(t("twoFactorDisabled"));
          renderAccount(main);
        } else {
          const r = await api.post("api/2fa/recovery", body);
          renderTfa(box, "codes", main, { codes: r.recoveryCodes });
        }
      } catch (ex) {
        restore();
        showError(ex);
      }
    });
  }
}

export async function renderAccount(main) {
  const u = state.user;
  const isAdmin = u.role === "admin";
  const [people, tfa] = await Promise.all([
    isAdmin ? api.get("api/users").catch(() => null) : null,
    api.get("api/2fa").catch(() => ({ enabled: false, recoveryLeft: 0 })),
  ]);
  let n = 0;
  const num = () => String(++n).padStart(2, "0");

  main.innerHTML = `
    <section class="page">
      <div class="page-head">
        <div>
          <p class="mono kicker fade">${esc(t("accountKicker"))}</p>
          <h1 class="serif page-title">${titleHtml(t("accountTitle"))}</h1>
        </div>
        <div class="head-side fade" style="--d:.35s"><p class="lead">${esc(u.email)} · ${esc(t(isAdmin ? "roleAdmin" : "roleMember"))}</p></div>
      </div>
      <div class="sections fade" style="--d:.45s">
        ${section(num(), esc(t("profile")), `
          <form id="profile" novalidate>
            <div class="field"><label class="mono" for="p-name">${esc(t("name"))}</label>
              <input class="input" id="p-name" name="name" autocomplete="name" maxlength="80" required value="${esc(u.name)}"></div>
            <p class="error" role="alert" hidden></p>
            <button class="btn ghost" type="submit">${esc(t("saveName"))}</button>
          </form>`)}
        ${section(num(), esc(t("twoFactor")), `<div id="tfa"></div>`, tfa.enabled ? t("twoFactorOn", tfa.recoveryLeft) : t("twoFactorOff"))}
        ${section(num(), esc(t("changePassword")), `
          <form id="password" novalidate>
            <input type="text" name="username" autocomplete="username" value="${esc(u.email)}" hidden>
            <div class="field"><label class="mono" for="pw-cur">${esc(t("currentPassword"))}</label>
              <input class="input" id="pw-cur" name="current" type="password" autocomplete="current-password" required></div>
            <div class="field"><label class="mono" for="pw-new">${esc(t("newPassword"))}</label>
              <input class="input" id="pw-new" name="next" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" required>
              <span class="hint">${esc(t("passwordHint", PASSWORD_MIN))}</span></div>
            <p class="error" role="alert" hidden></p>
            <button class="btn ghost" type="submit">${esc(t("changePassword"))}</button>
          </form>`)}
        ${section(num(), esc(t("backup")), `
          <div class="inline-actions">
            <a class="btn ghost" href="api/spaces/export" download>${esc(t("export"))} ↓</a>
            <button class="btn ghost" type="button" id="import-btn">${esc(t("import"))} ↑</button>
            <input class="file-input" type="file" id="import-file" accept="application/json,.json" tabindex="-1" aria-hidden="true">
          </div>`, t("backupText"))}
        ${isAdmin && people ? section(num(), esc(t("members")), `
          <div id="people">${peopleHtml(people)}</div>
          <form class="invite-form" id="invite" novalidate>
            <div class="field"><label class="mono" for="inv-role">${esc(t("inviteAs"))}</label>
              <select class="input" id="inv-role" name="role">
                <option value="member">${esc(t("roleMember"))}</option>
                <option value="admin">${esc(t("roleAdmin"))}</option>
              </select></div>
            <button class="btn signal" type="submit">${esc(t("invite"))}</button>
          </form>
          <div id="invite-out"></div>`, t("membersText")) : ""}
        ${section(num(), esc(t("signOut")), `<button class="btn ghost" type="button" id="logout">${esc(t("signOut"))}</button>`, t("signOutText"))}
      </div>
    </section>`;

  renderTfa($("#tfa", main), tfa.enabled ? "on" : "off", main);

  const formError = (form, ex) => {
    const p = $(".error", form);
    p.textContent = errorText(ex.code, ex.extra);
    p.hidden = false;
  };

  $("#profile", main).addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    $(".error", form).hidden = true;
    const restore = busy($("button", form), "…");
    try {
      const { user } = await api.patch("api/me", { name: $("#p-name", main).value });
      Object.assign(state.user, user);
      toast(t("nameSaved"));
      route();
    } catch (ex) {
      restore();
      formError(form, ex);
    }
  });

  $("#password", main).addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    $(".error", form).hidden = true;
    const restore = busy($("button", form), "…");
    try {
      await api.post("api/password", { current: form.current.value, next: form.next.value });
      form.reset();
      restore();
      toast(t("passwordChanged"));
    } catch (ex) {
      restore();
      formError(form, ex);
    }
  });

  const file = $("#import-file", main);
  $("#import-btn", main).addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    let data;
    try {
      if (f.size > 2_000_000) throw new Error();
      data = JSON.parse(await f.text());
    } catch {
      return toast(t("importBad"), "error");
    }
    try {
      const r = await api.post("api/spaces/import", data);
      await refreshSpaces();
      toast(t("imported", r.added, r.skipped, r.invalid));
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    }
  });

  const refreshPeople = async () => {
    const data = await api.get("api/users");
    $("#people", main).innerHTML = peopleHtml(data);
  };

  $("#invite", main)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const restore = busy($("button", e.currentTarget), "…");
    try {
      const r = await api.post("api/invites", { role: $("#inv-role", main).value });
      restore();
      $("#invite-out", main).innerHTML = `
        <div class="invite-link">
          <span class="mono">${esc(t("inviteLink"))}</span>
          <code>${esc(r.url)}</code>
          <div><button class="btn ghost" type="button" id="copy" style="margin-top:4px">${esc(t("copy"))}</button></div>
        </div>`;
      $("#copy", main).addEventListener("click", () =>
        navigator.clipboard?.writeText(r.url).then(() => toast(t("copied"))).catch(() => {}));
      refreshPeople().catch(() => {});
    } catch (ex) {
      restore();
      toast(errorText(ex.code, ex.extra), "error");
    }
  });

  $("#people", main)?.addEventListener("click", async (e) => {
    const revoke = e.target.closest("[data-revoke]");
    const remove = e.target.closest("[data-remove-user]");
    try {
      if (revoke) {
        await api.del(`api/invites/${encodeURIComponent(revoke.dataset.revoke)}`);
        $("#invite-out", main).innerHTML = "";
        await refreshPeople();
      } else if (remove) {
        const name = remove.dataset.name;
        const ok = await confirmBox({ title: t("removeMemberTitle", name), text: t("removeMemberText"), ok: t("removeMember"), danger: true });
        if (!ok) return;
        await api.del(`api/users/${encodeURIComponent(remove.dataset.removeUser)}`);
        await refreshPeople();
      }
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    }
  });

  $("#logout", main).addEventListener("click", async () => {
    await api.post("api/logout").catch(() => {});
    await reloadState().catch(() => { state.user = null; });
    location.hash = "#/";
    route();
  });

}

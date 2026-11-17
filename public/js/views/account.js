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

export async function renderAccount(main) {
  const u = state.user;
  const isAdmin = u.role === "admin";
  const people = isAdmin ? await api.get("api/users").catch(() => null) : null;
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

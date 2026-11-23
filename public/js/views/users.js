/*
 * Utilisateurs gérés par le Board (docs/users-api.md) : les comptes du Board, et pour chaque personne,
 * les instances auxquelles elle a accès, avec son rôle et ses restrictions tels que chaque appli les décrit.
 * Réservé aux administrateurs du Board. Tout ce qui vient d'une appli est affiché en texte brut (esc).
 */
import { api } from "../api.js";
import { go, refreshSpaces, state, titleHtml } from "../app.js";
import { errorText, lang, relTime, t } from "../i18n.js";
import { hostOf } from "../normalize.js";
import { $, busy, confirmBox, esc, logoTile, toast } from "../ui.js";
import { fieldHtml, readValues } from "./admin.js";

const section = (n, title, body, lead = "") => `
  <div class="section">
    <div><span class="num mono">(${n})</span><h2 class="serif">${title}</h2>${lead ? `<p class="lead" style="margin-top:14px">${esc(lead)}</p>` : ""}</div>
    <div class="section-body">${body}</div>
  </div>`;

const roleName = (role) => t(role === "admin" ? "roleAdmin" : "roleMember");
const appOf = (s) => (s.appId ? state.catalog?.appById[s.appId] : undefined);

/** Une erreur, avec le message de l'appli s'il y en a un (texte brut). */
function errorWithApp(ex) {
  const msg = ex.extra?.message;
  if (ex.code === "admin_app_error" && msg) return msg;
  return msg ? `${errorText(ex.code, ex.extra)} — ${msg}` : errorText(ex.code, ex.extra);
}

/** Lien à montrer une seule fois, avec un bouton « Copier ». */
function revealHtml(label, url) {
  return `<div class="invite-link a-reveal" role="status">
    <span class="mono">${esc(label)}</span>
    <code>${esc(url)}</code>
    <div><button class="btn ghost" type="button" data-copy="${esc(url)}" style="margin-top:4px">${esc(t("copy"))}</button></div>
  </div>`;
}

function onCopy(root) {
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => toast(t("copied"))).catch(() => {});
  });
}

/* ---------- Liste des comptes ---------- */

function peopleHtml(data) {
  const me = state.user.id;
  return `<div class="people">
    ${data.users.map((u) => `
      <div class="person">
        <span class="avatar" aria-hidden="true">${esc((u.name.trim()[0] || "?").toUpperCase())}</span>
        <span class="who"><strong>${esc(u.name)}${u.id === me ? ` <span class="mono" style="display:inline;color:var(--signal)">· ${esc(t("you"))}</span>` : ""}</strong>
          <span class="mono">${esc(u.email)} · ${esc(roleName(u.role))} · ${esc(u.role === "admin" ? t("allInstances") : t("instancesCount", u.spaces))}${u.pending ? ` · ${esc(t("userPending"))}` : ""}</span></span>
        <a class="text-btn mono" href="#/utilisateurs/${encodeURIComponent(u.id)}">${esc(t("manage"))}</a>
      </div>`).join("")}
    ${data.invites.map((i) => `
      <div class="person pending">
        <span class="avatar" aria-hidden="true">+</span>
        <span class="who"><strong>${esc(roleName(i.role))}</strong><span class="mono">${esc(t("pendingInvite", relTime(i.expiresAt)))}</span></span>
        <button class="text-btn mono danger" type="button" data-revoke="${esc(i.id)}">${esc(t("revoke"))}</button>
      </div>`).join("")}
  </div>`;
}

const roleSelect = (id, value = "member", disabled = false) => `
  <select class="input" id="${id}" name="role"${disabled ? " disabled" : ""}>
    <option value="member"${value === "member" ? " selected" : ""}>${esc(t("roleMember"))}</option>
    <option value="admin"${value === "admin" ? " selected" : ""}>${esc(t("roleAdmin"))}</option>
  </select>`;

async function renderUserList(main) {
  const data = await api.get("api/users");
  main.innerHTML = `
    <section class="page">
      <div class="page-head">
        <div>
          <p class="mono kicker fade">${esc(t("usersKicker"))}</p>
          <h1 class="serif page-title">${titleHtml(t("usersTitle"))}</h1>
        </div>
        <div class="head-side fade" style="--d:.35s"><p class="lead">${esc(t("usersText"))}</p></div>
      </div>
      <div class="sections fade" style="--d:.45s">
        ${section("01", esc(t("usersAccounts")), `<div id="people">${peopleHtml(data)}</div>`, t("usersAccountsText"))}
        ${section("02", esc(t("userCreate")), `
          <form class="invite-form" id="create" novalidate>
            <div class="field"><label class="mono" for="c-name">${esc(t("userName"))}</label>
              <input class="input" id="c-name" name="name" autocomplete="off" maxlength="80" required></div>
            <div class="field"><label class="mono" for="c-email">${esc(t("email"))}</label>
              <input class="input" id="c-email" name="email" type="email" autocomplete="off" inputmode="email" required></div>
            <div class="field"><label class="mono" for="c-role">${esc(t("boardRole"))}</label>${roleSelect("c-role")}</div>
            <button class="btn signal" type="submit">${esc(t("userCreateBtn"))}</button>
          </form>
          <p class="error" role="alert" hidden></p>
          <div id="create-out"></div>`, t("userCreateText"))}
        ${section("03", esc(t("inviteSection")), `
          <form class="invite-form" id="invite" novalidate>
            <div class="field"><label class="mono" for="inv-role">${esc(t("inviteAs"))}</label>${roleSelect("inv-role")}</div>
            <button class="btn ghost" type="submit">${esc(t("invite"))}</button>
          </form>
          <div id="invite-out"></div>`, t("inviteSectionText"))}
      </div>
    </section>`;
  onCopy(main);

  const refresh = async () => { $("#people", main).innerHTML = peopleHtml(await api.get("api/users")); };

  $("#create", main).addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const err = $(".error", form.parentElement);
    err.hidden = true;
    const restore = busy($("button", form), "…");
    try {
      const r = await api.post("api/users", { name: form.name.value, email: form.email.value, role: form.role.value, lang });
      restore();
      form.reset();
      $("#create-out", main).innerHTML = `${revealHtml(t("activationLink"), r.link.url)}
        <p class="hint" style="margin-top:12px">${esc(t("userCreated", r.user.name))}</p>
        <a class="btn signal" href="#/utilisateurs/${encodeURIComponent(r.user.id)}">${esc(t("userAccessTitle"))} →</a>`;
      refresh().catch(() => {});
    } catch (ex) {
      restore();
      err.textContent = errorText(ex.code, ex.extra);
      err.hidden = false;
    }
  });

  $("#invite", main).addEventListener("submit", async (e) => {
    e.preventDefault();
    const restore = busy($("button", e.currentTarget), "…");
    try {
      const r = await api.post("api/invites", { role: $("#inv-role", main).value });
      restore();
      $("#invite-out", main).innerHTML = revealHtml(t("inviteLink"), r.url);
      refresh().catch(() => {});
    } catch (ex) {
      restore();
      toast(errorText(ex.code, ex.extra), "error");
    }
  });

  $("#people", main).addEventListener("click", async (e) => {
    const revoke = e.target.closest("[data-revoke]");
    if (!revoke) return;
    try {
      await api.del(`api/invites/${encodeURIComponent(revoke.dataset.revoke)}`);
      $("#invite-out", main).innerHTML = "";
      await refresh();
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    }
  });
}

/* ---------- Une personne : ses accès ---------- */

/**
 * Carte d'une instance. `schema` : ce que l'appli propose ({ roles, fields, … }), `null` pendant la lecture,
 * ou { error } si l'appli ne le propose pas. `draft` : l'accès est en train d'être donné (pas encore enregistré).
 */
function cardHtml(entry, schema, draft) {
  const { space, access } = entry;
  const app = appOf(space);
  const on = Boolean(access && !access.revoked) || draft;
  const id = `acc-${space.id}`;
  let status = "";
  if (access?.sync) {
    status = access.sync.status === "ok"
      ? `<span class="tag-sso">${esc(t("syncOk", relTime(access.sync.at)))}</span>`
      : `<span class="tag-warn" title="${esc([access.sync.code ? errorText(access.sync.code, access.sync) : "", access.sync.message ?? ""].filter(Boolean).join(" — "))}">${esc(t(access.revoked ? "syncRemoval" : "syncError"))}</span>
         <button class="text-btn mono" type="button" data-resync>${esc(t("resync"))}</button>`;
  } else if (access && !access.managed) {
    status = `<span class="mono acc-note">${esc(t("accessUnmanaged"))}</span>`;
  }

  let body = "";
  if (on) {
    if (!space.sso) body = `<p class="hint">${esc(t("accessNoSso"))}</p>`;
    else if (schema === null) body = `<p class="hint">${esc(t("accessLoading"))}</p>`;
    else if (schema.error) {
      body = `<p class="hint">${esc(schema.error === "users_unsupported" ? t("accessUnsupported") : `${t("accessSchemaError")} ${errorWithApp(schema)}`)}</p>`;
    } else {
      const current = access?.managed ? access.role : draft ? schema.defaultRole : "";
      const role = entry.role ?? current;
      const fields = role ? schema.fields.filter((f) => !f.roles || f.roles.includes(role)) : [];
      const values = { ...(access?.values ?? {}), ...(entry.values ?? {}) };
      const desc = schema.roles.find((r) => r.value === role)?.description;
      body = `
        <form class="acc-form" novalidate>
          <div class="field"><label class="mono" for="${id}-role">${esc(t("accessRole"))}</label>
            <select class="input" id="${id}-role" name="__role">
              ${schema.roles.map((r) => `<option value="${esc(r.value)}"${r.value === role ? " selected" : ""}>${esc(r.label)}</option>`).join("")}
              <option value=""${role ? "" : " selected"}>${esc(t("accessNoRole"))}</option>
            </select>
            <span class="hint">${esc(role ? desc ?? "" : t("accessNoRoleHint"))}</span></div>
          ${fields.map((f) => fieldHtml({ ...f, value: f.name in values ? values[f.name] : f.value }, id)).join("")}
          <div class="inline-actions">
            <button class="btn signal" type="submit">${esc(t(access && !access.revoked ? "accessSave" : "accessGive"))}</button>
          </div>
        </form>`;
    }
  }
  const host = hostOf(space.base);
  return `
    <article class="acc-card${on ? " on" : ""}" data-space="${esc(space.id)}">
      <div class="acc-head">
        ${logoTile(app, space.name)}
        <span class="acc-title"><span class="serif">${esc(space.name)}</span><span class="mono">${esc(host)}${access?.managed && !access.revoked ? ` · ${esc(access.label)}` : ""}</span></span>
        <label class="check" for="${id}-on"><input type="checkbox" id="${id}-on" data-toggle${on ? " checked" : ""}><span class="box" aria-hidden="true"></span><span class="mono">${esc(t("accessOn"))}</span></label>
      </div>
      ${status ? `<div class="acc-status">${status}</div>` : ""}
      ${body ? `<div class="acc-body">${body}</div>` : ""}
    </article>`;
}

async function renderUser(main, id) {
  let data;
  try {
    data = await api.get(`api/users/${encodeURIComponent(id)}`);
  } catch (ex) {
    toast(errorText(ex.code, ex.extra), "error");
    return go("#/utilisateurs");
  }
  const u = data.user;
  const self = u.id === state.user.id;
  const schemas = new Map(); // id d'instance → schéma, null (lecture), ou { error }
  const drafts = new Set(); // instances dont l'accès est en train d'être donné
  const entries = new Map(data.spaces.map((e) => [e.space.id, e]));

  main.innerHTML = `
    <section class="page">
      <a class="text-btn mono fade" href="#/utilisateurs">${esc(t("backToUsers"))}</a>
      <div class="page-head" style="margin-top:20px">
        <div>
          <p class="mono kicker fade">${esc(t("userKicker"))}</p>
          <h1 class="serif page-title">${titleHtml(esc(u.name))}</h1>
        </div>
        <div class="head-side fade" style="--d:.35s"><p class="lead">${esc(u.email)} · ${esc(roleName(u.role))}${u.pending ? ` · ${esc(t("userPending"))}` : ""}</p></div>
      </div>
      <div class="sections fade" style="--d:.45s">
        ${section("01", esc(t("userAccessTitle")), `
          ${u.role === "admin" ? `<p class="hint">${esc(t("userAccessAdminNote"))}</p>` : ""}
          <div class="acc-list" id="cards">${data.spaces.length ? "" : `<p class="hint">${esc(t("noInstances"))}</p>`}</div>`, t("userAccessText"))}
        ${section("02", esc(t("profile")), `
          <form id="profile" novalidate>
            <div class="field"><label class="mono" for="u-name">${esc(t("userName"))}</label>
              <input class="input" id="u-name" name="name" maxlength="80" required value="${esc(u.name)}"></div>
            <div class="field"><label class="mono" for="u-email">${esc(t("email"))}</label>
              <input class="input" id="u-email" name="email" type="email" required value="${esc(u.email)}"></div>
            <div class="field"><label class="mono" for="u-role">${esc(t("boardRole"))}</label>${roleSelect("u-role", u.role, self)}</div>
            <p class="error" role="alert" hidden></p>
            <button class="btn ghost" type="submit">${esc(t("save"))}</button>
          </form>`)}
        ${section("03", esc(t("userPassword")), `
          <button class="btn ghost" type="button" id="reset">${esc(t("userResetBtn"))}</button>
          <div id="reset-out"></div>`, u.pending ? t("userPasswordPending") : t("userPasswordText"))}
        ${self ? "" : section("04", esc(t("userDelete")), `
          <button class="btn ghost danger-btn" type="button" id="delete">${esc(t("userDelete"))}</button>`, t("userDeleteText"))}
      </div>
    </section>`;
  onCopy(main);

  const cards = $("#cards", main);
  const draw = (sid) => {
    const e = entries.get(sid);
    const html = cardHtml(e, schemas.has(sid) ? schemas.get(sid) : null, drafts.has(sid));
    const old = $(`.acc-card[data-space="${CSS.escape(sid)}"]`, cards);
    if (old) old.outerHTML = html;
    else cards.insertAdjacentHTML("beforeend", html);
  };
  for (const e of data.spaces) draw(e.space.id);

  /** Ce que l'appli propose : lu une fois par instance, quand il sert. */
  const loadSchema = async (sid) => {
    if (schemas.has(sid) || !entries.get(sid).space.sso) return;
    schemas.set(sid, null);
    try {
      schemas.set(sid, await api.get(`api/spaces/${encodeURIComponent(sid)}/roles?lang=${lang}`));
    } catch (ex) {
      schemas.set(sid, { error: ex.code, extra: ex.extra, code: ex.code });
    }
    draw(sid);
  };
  for (const e of data.spaces) if (e.access && !e.access.revoked && e.space.sso) loadSchema(e.space.id);

  const saved = (sid, r, key) => {
    const e = entries.get(sid);
    e.access = r.access ?? null;
    delete e.role;
    delete e.values;
    drafts.delete(sid);
    draw(sid);
    toast(t(r.sync && !r.sync.ok ? `${key}Pending` : key, e.space.name), r.sync && !r.sync.ok ? "error" : "info");
    if (r.sync?.ok && r.sync.message) toast(`${e.space.name} : ${r.sync.message}`);
    if (self) refreshSpaces().catch(() => {});
  };

  cards.addEventListener("change", async (e) => {
    const card = e.target.closest(".acc-card");
    if (!card) return;
    const sid = card.dataset.space;
    const entry = entries.get(sid);
    if (e.target.matches("[data-toggle]")) {
      const has = Boolean(entry.access && !entry.access.revoked);
      if (e.target.checked) {
        // Appli qui gère ses comptes : on choisit d'abord le rôle. Sinon, l'accès est donné tout de suite.
        if (entry.space.sso) {
          drafts.add(sid);
          draw(sid);
          await loadSchema(sid);
          const s = schemas.get(sid);
          if (!s?.error) return;
          drafts.delete(sid);
        }
        try {
          saved(sid, await api.put(`api/spaces/${encodeURIComponent(sid)}/access/${encodeURIComponent(u.id)}?lang=${lang}`, {}), "accessSaved");
        } catch (ex) {
          draw(sid);
          toast(errorWithApp(ex), "error");
        }
        return;
      }
      if (!has) {
        drafts.delete(sid);
        return draw(sid);
      }
      const ok = await confirmBox({ title: t("accessRemoveTitle", u.name, entry.space.name), text: t("accessRemoveText"), ok: t("accessRemove"), danger: true });
      if (!ok) return draw(sid);
      try {
        const r = await api.del(`api/spaces/${encodeURIComponent(sid)}/access/${encodeURIComponent(u.id)}?lang=${lang}`);
        saved(sid, { access: r.removed ? null : r.access, sync: r.sync }, "accessRemoved");
      } catch (ex) {
        draw(sid);
        toast(errorWithApp(ex), "error");
      }
      return;
    }
    if (e.target.name === "__role") {
      // Autre rôle : ses restrictions à lui (les valeurs saisies sont gardées).
      const form = e.target.form;
      const s = schemas.get(sid);
      entry.values = { ...(entry.values ?? {}), ...readValues(form, s.fields.filter((f) => form.elements.namedItem(f.name))) };
      entry.role = e.target.value;
      draw(sid);
    }
  });

  cards.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const card = form.closest(".acc-card");
    const sid = card.dataset.space;
    const s = schemas.get(sid);
    const role = form.elements.namedItem("__role").value;
    const values = Object.fromEntries(Object.entries(readValues(form, s.fields.filter((f) => form.elements.namedItem(f.name)))).filter(([, v]) => v !== ""));
    const restore = busy($("button[type=submit]", form), "…");
    try {
      saved(sid, await api.put(`api/spaces/${encodeURIComponent(sid)}/access/${encodeURIComponent(u.id)}?lang=${lang}`, { role, values }), "accessSaved");
    } catch (ex) {
      restore();
      toast(errorWithApp(ex), "error");
    }
  });

  cards.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-resync]");
    if (!b) return;
    const sid = b.closest(".acc-card").dataset.space;
    const restore = busy(b, "…");
    try {
      const r = await api.post(`api/spaces/${encodeURIComponent(sid)}/access/${encodeURIComponent(u.id)}/sync?lang=${lang}`);
      const removed = r.removed === true;
      saved(sid, { access: removed ? null : r.access, sync: r.sync }, removed ? "accessRemoved" : "accessSaved");
    } catch (ex) {
      restore();
      toast(errorWithApp(ex), "error");
    }
  });

  $("#profile", main).addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const err = $(".error", form);
    err.hidden = true;
    const restore = busy($("button", form), "…");
    try {
      const body = { name: form.name.value, email: form.email.value, ...(self ? {} : { role: form.role.value }) };
      await api.patch(`api/users/${encodeURIComponent(u.id)}`, body);
      toast(t("profileSaved"));
      if (self) Object.assign(state.user, { name: body.name, email: body.email });
      renderUser(main, u.id);
    } catch (ex) {
      restore();
      err.textContent = errorText(ex.code, ex.extra);
      err.hidden = false;
    }
  });

  $("#reset", main).addEventListener("click", async (e) => {
    const restore = busy(e.currentTarget, "…");
    try {
      const r = await api.post(`api/users/${encodeURIComponent(u.id)}/password-link`);
      restore();
      $("#reset-out", main).innerHTML = revealHtml(t(u.pending ? "activationLink" : "resetLink"), r.url);
    } catch (ex) {
      restore();
      toast(errorText(ex.code, ex.extra), "error");
    }
  });

  $("#delete", main)?.addEventListener("click", async () => {
    const ok = await confirmBox({ title: t("userDeleteTitle", u.name), text: t("userDeleteText"), ok: t("userDelete"), danger: true });
    if (!ok) return;
    try {
      const r = await api.del(`api/users/${encodeURIComponent(u.id)}?lang=${lang}`);
      toast(t("userDeleted", u.name));
      if (r.warnings?.length) toast(t("userDeleteWarn", r.warnings.map((w) => w.space).join(", ")), "error");
      go("#/utilisateurs");
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    }
  });
}

export async function renderUsers(main, { id } = {}) {
  if (state.user.role !== "admin") return go("#/");
  try {
    if (id) await renderUser(main, id);
    else await renderUserList(main);
  } catch (ex) {
    main.innerHTML = `<section class="page"><p class="error">${esc(errorText(ex.code, ex.extra))}</p></section>`;
  }
}

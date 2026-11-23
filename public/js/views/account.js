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

/* ---------- Appareils (Kosmy Mobile) ---------- */

function devicesHtml(devices) {
  if (!devices.length) return `<p class="hint">${esc(t("devicesNone"))}</p>`;
  return `<div class="people">
    ${devices.map((d) => `
      <div class="person">
        <span class="avatar" aria-hidden="true">${esc((d.name.trim()[0] || "?").toUpperCase())}</span>
        <span class="who"><strong>${esc(d.name)}</strong><span class="mono">${esc(t("deviceSeen", relTime(d.seenAt)))}</span></span>
        <button class="text-btn mono danger" type="button" data-device="${esc(d.id)}" data-name="${esc(d.name)}">${esc(t("deviceRevoke"))}</button>
      </div>`).join("")}
  </div>`;
}

/* ---------- Accès MCP (Claude Code, Claude Desktop, claude.ai…) ---------- */

function mcpHtml(data, created = null) {
  const cmd = (tok) => `claude mcp add --transport http kosmy-board ${data.url} --header "Authorization: Bearer ${tok}"`;
  const rows = [
    ...data.grants.map((g) => `
      <div class="person">
        <span class="avatar" aria-hidden="true">${esc((g.client.trim()[0] || "?").toUpperCase())}</span>
        <span class="who"><strong>${esc(g.client)}</strong><span class="mono">${esc(t("mcpGrant", relTime(g.createdAt)))}</span></span>
        <button class="text-btn mono danger" type="button" data-mcp-grant="${esc(g.id)}" data-name="${esc(g.client)}">${esc(t("deviceRevoke"))}</button>
      </div>`),
    ...data.tokens.map((k) => `
      <div class="person">
        <span class="avatar" aria-hidden="true">#</span>
        <span class="who"><strong>${esc(k.name)}</strong><span class="mono">${esc(k.lastUsedAt ? t("deviceSeen", relTime(k.lastUsedAt)) : t("mcpTokenUnused"))}</span></span>
        <button class="text-btn mono danger" type="button" data-mcp-token="${esc(k.id)}" data-name="${esc(k.name)}">${esc(t("deviceRevoke"))}</button>
      </div>`),
  ];
  return `
    <div class="setting"><span class="label mono">${esc(t("mcpUrl"))}</span><code>${esc(data.url)}</code>
      <button class="text-btn mono" type="button" data-copy="${esc(data.url)}">${esc(t("copy2"))}</button>
      <span class="hint">${esc(t("mcpUrlHint"))}</span></div>
    ${created ? `<div class="invite-link a-reveal" role="status">
        <span class="mono">${esc(t("mcpTokenOnce"))}</span>
        <code>${esc(created.token)}</code>
        <div class="inline-actions" style="margin-top:4px">
          <button class="text-btn mono" type="button" data-copy="${esc(created.token)}">${esc(t("copy2"))}</button>
          <button class="text-btn mono" type="button" data-copy="${esc(cmd(created.token))}">${esc(t("mcpCopyCommand"))}</button>
        </div></div>` : ""}
    ${rows.length ? `<div class="people" style="margin-top:20px">${rows.join("")}</div>` : `<p class="hint" style="margin-top:16px">${esc(t("mcpNone"))}</p>`}
    <form class="invite-form" id="mcp-new" style="margin-top:20px">
      <div class="field" style="margin-top:0"><label class="mono" for="mcp-name">${esc(t("mcpTokenName"))}</label>
        <input class="input" id="mcp-name" maxlength="60" placeholder="Claude Code" autocomplete="off"></div>
      <button class="btn ghost" type="submit">${esc(t("mcpCreateToken"))}</button>
    </form>`;
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
  const [tfa, devices, mcpData] = await Promise.all([
    api.get("api/2fa").catch(() => ({ enabled: false, recoveryLeft: 0 })),
    api.get("api/devices").then((r) => r.devices).catch(() => []),
    api.get("api/mcp").catch(() => null),
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
        ${section(num(), esc(t("devices")), `<div id="devices">${devicesHtml(devices)}</div>`, t("devicesText"))}
        ${mcpData ? section(num(), esc(t("mcpTitle")), `<div id="mcp">${mcpHtml(mcpData)}</div>`, t("mcpText")) : ""}
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
            ${isAdmin ? `<button class="btn ghost" type="button" id="import-btn">${esc(t("import"))} ↑</button>
            <input class="file-input" type="file" id="import-file" accept="application/json,.json" tabindex="-1" aria-hidden="true">` : ""}
          </div>`, t("backupText"))}
        ${isAdmin ? section(num(), esc(t("usersNav")), `
          <a class="btn signal" href="#/utilisateurs">${esc(t("membersManage"))}</a>`, t("membersShortText")) : ""}
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
  $("#import-btn", main)?.addEventListener("click", () => file.click());
  file?.addEventListener("change", async () => {
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

  $("#devices", main).addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-device]");
    if (!btn) return;
    const ok = await confirmBox({ title: t("deviceRevokeTitle", btn.dataset.name), text: t("deviceRevokeText"), ok: t("deviceRevoke"), danger: true });
    if (!ok) return;
    try {
      await api.del(`api/devices/${encodeURIComponent(btn.dataset.device)}`);
      toast(t("deviceRevoked"));
      const r = await api.get("api/devices");
      $("#devices", main).innerHTML = devicesHtml(r.devices);
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    }
  });

  const mcpBox = $("#mcp", main);
  const redrawMcp = async (created = null) => {
    mcpBox.innerHTML = mcpHtml(await api.get("api/mcp"), created);
  };
  mcpBox?.addEventListener("submit", async (e) => {
    if (e.target.id !== "mcp-new") return;
    e.preventDefault();
    const restore = busy(e.submitter, "…");
    try {
      const created = await api.post("api/mcp/tokens", { name: $("#mcp-name", main).value });
      await redrawMcp(created);
    } catch (ex) {
      restore();
      toast(errorText(ex.code, ex.extra), "error");
    }
  });
  mcpBox?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-mcp-token], [data-mcp-grant]");
    if (!btn) return;
    const ok = await confirmBox({ title: t("mcpRevokeTitle", btn.dataset.name), text: t("mcpRevokeText"), ok: t("deviceRevoke"), danger: true });
    if (!ok) return;
    try {
      if (btn.dataset.mcpToken) await api.del(`api/mcp/tokens/${encodeURIComponent(btn.dataset.mcpToken)}`);
      else await api.del(`api/mcp/grants/${encodeURIComponent(btn.dataset.mcpGrant)}`);
      toast(t("deviceRevoked"));
      await redrawMcp();
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

/*
 * L'Assistant : un agent IA qui gère vos instances (docs/assistant.md).
 * Cette page : la liste des conversations et le chat (views/chat.js), puis les réglages.
 */
import { api } from "../api.js";
import { go, state, titleHtml } from "../app.js";
import { errorText, lang, relTime, t } from "../i18n.js";
import { $, busy, confirmBox, esc, toast } from "../ui.js";
import { mountChat, revealHtml } from "./chat.js";

const base = "api/assistant";

/* ---------- La page ---------- */

let current = null; // chat affiché (pour interrompre sa réponse en quittant la page)

export async function renderAssistant(main, { id, sub }) {
  current?.abort();
  current = null;
  if (id === "reglages") return renderSettings(main);
  let info;
  try {
    info = await api.get(base);
  } catch (e) {
    main.innerHTML = `<section class="page"><p class="error" role="alert">${esc(errorText(e.code, e.extra))}</p></section>`;
    return;
  }
  let conv = null;
  if (id) {
    try {
      conv = await api.get(`${base}/conversations/${encodeURIComponent(id)}`);
    } catch (e) {
      toast(errorText(e.code, e.extra), "error");
      go("#/assistant");
      return;
    }
  }

  const convItem = (c, currentId = conv?.id) => `<li><a class="ai-conv${c.id === currentId ? " current" : ""}" href="#/assistant/${esc(c.id)}"${c.id === currentId ? ' aria-current="page"' : ""}>
      <span class="ai-conv-title">${c.source === "report" ? `<span class="pill mono">${esc(t("aiReport"))}</span> ` : ""}${esc(c.title)}</span>
      <span class="mono ai-conv-time">${esc(relTime(c.updatedAt))}</span></a></li>`;

  const notReady = !info.configured
    ? `<div class="empty fade"><p class="mono">${esc(t("aiNotConfigured"))}</p><p>${esc(info.canConfigure ? t("aiNotConfiguredAdmin") : t("aiNotConfiguredMember"))}</p>
        ${info.canConfigure ? `<div class="inline-actions"><a class="btn signal" href="#/assistant/reglages">${esc(t("aiSettings"))} →</a></div>` : ""}</div>`
    : "";

  main.innerHTML = `
    <section class="page assistant">
      <div class="page-head">
        <div>
          <p class="mono kicker fade">${esc(t("aiKicker"))}</p>
          <h1 class="serif page-title">${titleHtml(t("aiTitle"))}</h1>
        </div>
        <div class="head-side fade" style="--d:.35s">
          <p class="lead">${esc(t("aiLead"))}</p>
          <p class="mono ai-model">${info.configured ? `${esc(info.provider)} · ${esc(info.model)}` : ""}</p>
          <div class="inline-actions" style="margin-top:0">
            <a class="text-btn mono" href="#/assistant">${esc(t("aiNew"))} +</a>
            <a class="text-btn mono" href="#/assistant/reglages">${esc(t("aiSettings"))}</a>
          </div>
        </div>
      </div>
      ${notReady}
      <div class="ai-layout"${info.configured ? "" : " hidden"}>
        <aside class="ai-side">
          <p class="mono ai-side-title">${esc(t("aiConversations"))}</p>
          ${info.conversations.length ? `<ul class="ai-convs">${info.conversations.map((c) => convItem(c)).join("")}</ul>` : `<p class="note">${esc(t("aiNoConversation"))}</p>`}
        </aside>
        <div class="ai-chat">
          <div class="ai-head">
            <h2 class="serif ai-chat-title">${esc(conv?.title ?? t("aiNew"))}</h2>
            ${conv ? `<button class="text-btn mono danger" type="button" id="ai-delete">${esc(t("aiDelete"))}</button>` : ""}
          </div>
          <div class="ai-chat-box" id="ai-chat-box"></div>
        </div>
      </div>
    </section>`;

  if (!info.configured) return;
  current = mountChat($("#ai-chat-box", main), {
    conversation: conv,
    autofocus: !sub,
    onConversation: (data) => {
      history.replaceState(null, "", `#/assistant/${data.id}`);
      $(".ai-chat-title", main).textContent = data.title;
      // La nouvelle conversation rejoint la liste de gauche.
      const side = $(".ai-side", main);
      let ul = $(".ai-convs", side);
      if (!ul) {
        $(".note", side)?.remove();
        side.insertAdjacentHTML("beforeend", '<ul class="ai-convs"></ul>');
        ul = $(".ai-convs", side);
      }
      ul.insertAdjacentHTML("afterbegin", convItem({ id: data.id, title: data.title, source: "chat", updatedAt: Date.now() }, data.id));
    },
  });

  $("#ai-delete", main)?.addEventListener("click", async () => {
    const ok = await confirmBox({ title: t("aiDeleteTitle"), text: t("aiDeleteText"), ok: t("aiDelete"), danger: true });
    if (!ok) return;
    try {
      await api.del(`${base}/conversations/${encodeURIComponent(conv.id)}`);
      go("#/assistant");
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    }
  });
}

/* ---------- Valeur à montrer une fois (lien donné par un outil appelé depuis le MCP) ---------- */

export async function renderReveal(main, id) {
  main.innerHTML = `<section class="page"><div class="page-head"><div>
      <p class="mono kicker fade">${esc(t("aiKicker"))}</p>
      <h1 class="serif page-title">${titleHtml(t("aiRevealTitle"))}</h1></div></div>
    <div id="ai-reveal-body"><p class="mono boot">${esc(t("loading"))}</p></div></section>`;
  const box = $("#ai-reveal-body", main);
  try {
    const r = await api.post(`${base}/reveal/${encodeURIComponent(id)}`, {});
    box.innerHTML = revealHtml(r);
  } catch (e) {
    box.innerHTML = `<p class="error" role="alert">${esc(errorText(e.code, e.extra))}</p>`;
  }
}

/* ---------- Réglages : fournisseur (administrateurs), bilans, journal ---------- */

const HOURS = Array.from({ length: 24 }, (_, h) => h);

async function renderSettings(main) {
  let info, ai = null, audit;
  try {
    [info, audit] = await Promise.all([api.get(base), api.get(`${base}/audit`)]);
    if (info.canConfigure) ai = await api.get(`${base}/settings`);
  } catch (e) {
    main.innerHTML = `<section class="page"><p class="error" role="alert">${esc(errorText(e.code, e.extra))}</p></section>`;
    return;
  }
  const r = info.report;
  const days = t("aiWeekdays");

  const providerSection = ai ? (() => {
    const locked = (k) => (ai.env[k] ? " disabled" : "");
    const lockNote = Object.values(ai.env).some(Boolean) ? `<p class="note">${esc(t("aiEnvLocked"))}</p>` : "";
    return `
      <div class="section">
        <div><span class="mono num">(01)</span><h2 class="serif">${esc(t("aiProvider"))}</h2><p class="lead">${esc(t("aiProviderLead"))}</p></div>
        <form class="section-body" id="ai-provider-form">
          <div class="field"><label class="mono" for="ai-provider">${esc(t("aiProvider"))}</label>
            <select class="input" id="ai-provider"${locked("provider")}>${ai.providers.map((p) => `<option value="${esc(p.id)}"${p.id === ai.provider ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select></div>
          <div class="field"><label class="mono" for="ai-base">${esc(t("aiBaseUrl"))}</label>
            <input class="input" id="ai-base" type="url" spellcheck="false" autocomplete="off" value="${esc(ai.baseUrl)}"${locked("baseUrl")}>
            <span class="hint">${esc(t("aiBaseUrlHint"))}</span></div>
          <div class="field"><label class="mono" for="ai-key">${esc(t("aiApiKey"))}</label>
            <input class="input" id="ai-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="${esc(ai.hasApiKey ? t("aiKeyKept") : "")}"${locked("apiKey")}>
            <span class="hint">${esc(t("aiApiKeyHint"))}</span></div>
          <div class="field"><label class="mono" for="ai-model">${esc(t("aiModel"))}</label>
            <input class="input" id="ai-model" list="ai-models" spellcheck="false" autocomplete="off" value="${esc(ai.model)}"${locked("model")}>
            <datalist id="ai-models"></datalist>
            <span class="hint" id="ai-models-hint">${esc(t("aiModelHint"))}</span></div>
          ${lockNote}
          <p class="error" role="alert" hidden></p>
          <div class="inline-actions">
            <button class="btn signal" type="submit">${esc(t("save"))}</button>
            <button class="btn ghost" type="button" id="ai-load-models">${esc(t("aiLoadModels"))}</button>
            <button class="btn ghost" type="button" id="ai-test">${esc(t("aiTest"))}</button>
          </div>
        </form>
      </div>`;
  })() : "";

  const auditRows = audit.entries.length
    ? `<ul class="ai-audit">${audit.entries.map((a) => `<li data-ok="${a.ok}">
        <span class="mono ai-audit-time">${esc(new Date(a.at).toLocaleString(lang))}</span>
        <span class="ai-audit-what"><strong>${esc(a.detail?.label ?? a.tool)}</strong>${a.space ? ` · ${esc(a.space)}` : ""}${a.message ? ` — ${esc(a.message)}` : ""}</span>
        <span class="mono ai-audit-meta">${esc(t(`aiChannel_${a.channel}`))}${info.canConfigure && a.user ? ` · ${esc(a.user)}` : ""} · ${a.ok ? "✓" : "✕"}</span></li>`).join("")}</ul>`
    : `<p class="note">${esc(t("aiAuditEmpty"))}</p>`;

  main.innerHTML = `
    <section class="page">
      <div class="page-head">
        <div>
          <a class="mono back" href="#/assistant">← ${esc(t("aiTitlePlain"))}</a>
          <h1 class="serif page-title">${titleHtml(t("aiSettingsTitle"))}</h1>
        </div>
        <div class="head-side fade" style="--d:.35s"><p class="lead">${esc(t("aiSettingsLead"))}</p></div>
      </div>
      ${providerSection}
      <div class="section">
        <div><span class="mono num">(${ai ? "02" : "01"})</span><h2 class="serif">${esc(t("aiReports"))}</h2><p class="lead">${esc(t("aiReportsLead"))}</p></div>
        <form class="section-body" id="ai-report-form">
          <div class="field"><label class="mono" for="ai-freq">${esc(t("aiFrequency"))}</label>
            <select class="input" id="ai-freq">${["off", "daily", "weekly"].map((f) => `<option value="${f}"${f === r.frequency ? " selected" : ""}>${esc(t(`aiFreq_${f}`))}</option>`).join("")}</select></div>
          <div class="field"><label class="mono" for="ai-weekday">${esc(t("aiWeekday"))}</label>
            <select class="input" id="ai-weekday">${days.map((d, i) => `<option value="${i}"${i === r.weekday ? " selected" : ""}>${esc(d)}</option>`).join("")}</select></div>
          <div class="field"><label class="mono" for="ai-hour">${esc(t("aiHour"))}</label>
            <select class="input" id="ai-hour">${HOURS.map((h) => `<option value="${h}"${h === r.hour ? " selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select>
            <span class="hint">${esc(t("aiHourHint"))}</span></div>
          ${r.lastRunAt ? `<p class="note">${esc(t("aiLastReport", relTime(r.lastRunAt)))}</p>` : ""}
          <div class="inline-actions">
            <button class="btn signal" type="submit">${esc(t("save"))}</button>
            ${info.configured ? `<button class="btn ghost" type="button" id="ai-run-report">${esc(t("aiRunReport"))}</button>` : ""}
          </div>
        </form>
      </div>
      <div class="section">
        <div><span class="mono num">(${ai ? "03" : "02"})</span><h2 class="serif">${esc(t("aiAudit"))}</h2><p class="lead">${esc(t("aiAuditLead"))}</p></div>
        <div class="section-body">${auditRows}</div>
      </div>
    </section>`;

  const freq = $("#ai-freq", main);
  const syncFreq = () => {
    $("#ai-weekday", main).closest(".field").hidden = freq.value !== "weekly";
    $("#ai-hour", main).closest(".field").hidden = freq.value === "off";
  };
  freq.addEventListener("change", syncFreq);
  syncFreq();
  $("#ai-report-form", main).addEventListener("submit", async (e) => {
    e.preventDefault();
    const restore = busy(e.submitter, "…");
    try {
      await api.put(`${base}/report`, { frequency: freq.value, hour: Number($("#ai-hour", main).value), weekday: Number($("#ai-weekday", main).value) });
      toast(t("saved"));
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    } finally {
      restore();
    }
  });

  $("#ai-run-report", main)?.addEventListener("click", async (e) => {
    const restore = busy(e.currentTarget, "…");
    try {
      await api.post(`${base}/report/run`, {});
      toast(t("aiReportStarted"));
    } catch (ex) {
      toast(errorText(ex.code, ex.extra), "error");
    } finally {
      restore();
    }
  });

  if (!ai) return;
  const form = $("#ai-provider-form", main);
  const err = $(".error", form);
  const providerSel = $("#ai-provider", main);
  const draft = () => ({
    provider: providerSel.value,
    baseUrl: $("#ai-base", main).value.trim(),
    model: $("#ai-model", main).value.trim(),
    apiKey: $("#ai-key", main).value.trim(),
  });
  const showErr = (ex) => {
    err.hidden = false;
    err.textContent = ex.extra?.message ? `${errorText(ex.code, ex.extra)} — ${ex.extra.message}` : errorText(ex.code, ex.extra);
  };
  providerSel.addEventListener("change", () => {
    const p = ai.providers.find((x) => x.id === providerSel.value);
    if (!ai.env.baseUrl) $("#ai-base", main).value = p.baseUrl;
    if (!ai.env.model) $("#ai-model", main).value = p.model;
    if (!ai.env.apiKey) {
      $("#ai-key", main).value = "";
      $("#ai-key", main).placeholder = p.noKey ? t("aiKeyNone") : "";
    }
    $("#ai-models", main).innerHTML = "";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const restore = busy(e.submitter, "…");
    try {
      const d = draft();
      ai = await api.put(`${base}/settings`, { provider: d.provider, baseUrl: d.baseUrl, model: d.model, ...(d.apiKey ? { apiKey: d.apiKey } : {}) });
      state.assistant = { configured: ai.configured }; // l'accueil montre (ou non) l'Assistant
      $("#ai-key", main).value = "";
      $("#ai-key", main).placeholder = ai.hasApiKey ? t("aiKeyKept") : "";
      toast(ai.configured ? t("aiSavedReady") : t("saved"));
    } catch (ex) {
      showErr(ex);
    } finally {
      restore();
    }
  });
  $("#ai-load-models", main).addEventListener("click", async (e) => {
    err.hidden = true;
    const restore = busy(e.currentTarget, "…");
    try {
      const { models } = await api.post(`${base}/models`, draft());
      $("#ai-models", main).innerHTML = models.map((m) => `<option value="${esc(m.id)}">${m.name ? esc(m.name) : ""}</option>`).join("");
      $("#ai-models-hint", main).textContent = t("aiModelsLoaded", models.length);
      $("#ai-model", main).focus();
    } catch (ex) {
      showErr(ex);
    } finally {
      restore();
    }
  });
  $("#ai-test", main).addEventListener("click", async (e) => {
    err.hidden = true;
    const restore = busy(e.currentTarget, "…");
    try {
      const r2 = await api.post(`${base}/test`, draft());
      toast(r2.tools ? t("aiTestOk") : t("aiTestNoTools"), r2.tools ? "info" : "error");
    } catch (ex) {
      showErr(ex);
    } finally {
      restore();
    }
  });
}

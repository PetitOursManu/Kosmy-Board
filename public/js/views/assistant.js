/*
 * L'Assistant : un agent IA qui gère vos instances (docs/assistant.md).
 * La réponse arrive en flux (Server-Sent Events). Tout ce qui vient du modèle ou des applis est échappé (esc),
 * puis mis en forme avec un Markdown minimal (paragraphes, listes, gras, code).
 */
import { api } from "../api.js";
import { go, state, titleHtml } from "../app.js";
import { errorText, lang, relTime, t } from "../i18n.js";
import { $, $$, busy, confirmBox, esc, toast } from "../ui.js";

const base = "api/assistant";

/* ---------- Markdown minimal (sur du texte déjà échappé) ---------- */

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}
export function md(text) {
  const lines = esc(text).split("\n");
  const out = [];
  let list = null; // "ul" | "ol"
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join("<br>"))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = /^\s*[-*•] +(.*)$/.exec(line);
    const ol = /^\s*\d+[.)] +(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line.replace(/^#+\s*/, ""));
    }
  }
  flushPara();
  closeList();
  return out.join("");
}

/* ---------- Flux SSE ---------- */

/** POST qui répond en text/event-stream : onEvent(nom, données) pour chaque événement. */
async function stream(url, body, onEvent, signal) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    onEvent("error", { error: "network" });
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    onEvent("error", data.error ? data : { error: "generic" });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) onEvent(ev, JSON.parse(data));
      }
    }
  } catch {
    if (!signal?.aborted) onEvent("error", { error: "network" });
  }
}

/* ---------- Morceaux d'interface ---------- */

const toolChip = (x) => `<li class="ai-tool" data-ok="${x.ok === null || x.ok === undefined ? "" : x.ok}">
  <span class="ai-tool-mark" aria-hidden="true">${x.ok === false ? "✕" : x.ok ? "✓" : "…"}</span>${esc(x.label)}</li>`;

function messageHtml(m) {
  if (m.role === "user") {
    if (m.kind) {
      const key = { confirmed: "aiNoteConfirmed", refused: "aiNoteRefused", failed: "aiNoteFailed" }[m.kind] ?? "aiNoteConfirmed";
      return `<p class="mono ai-note" data-kind="${esc(m.kind)}">${esc(t(key))}</p>`;
    }
    return `<div class="ai-msg user"><div class="ai-bubble">${md(m.text)}</div></div>`;
  }
  const tools = m.tools?.length ? `<ul class="ai-tools">${m.tools.map(toolChip).join("")}</ul>` : "";
  const text = m.text ? `<div class="ai-text">${md(m.text)}</div>` : "";
  if (!tools && !text) return "";
  return `<div class="ai-msg assistant">${tools}${text}</div>`;
}

function pendingHtml(p) {
  const values = p.values && Object.keys(p.values).length
    ? `<dl class="ai-values">${Object.entries(p.values).map(([k, v]) => `<dt class="mono">${esc(k)}</dt><dd>${esc(typeof v === "boolean" ? (v ? t("yes") : t("no")) : v)}</dd>`).join("")}</dl>`
    : "";
  return `<div class="ai-card${p.danger ? " danger" : ""}" data-pending="${esc(p.id)}" role="group" aria-label="${esc(t("aiPendingKicker"))}">
    <p class="mono ai-card-kicker">${esc(t("aiPendingKicker"))}${p.space ? ` · ${esc(p.space)}` : ""}</p>
    <p class="ai-card-title">${esc(p.title)}${p.row ? ` <span class="ai-card-row">— ${esc(p.row)}</span>` : ""}</p>
    ${p.confirm ? `<p class="ai-card-text">${esc(p.confirm)}</p>` : ""}
    ${values}
    <div class="inline-actions">
      <button class="btn ${p.danger ? "danger" : "signal"}" type="button" data-approve>${esc(t("aiApprove"))}</button>
      <button class="btn ghost" type="button" data-refuse>${esc(t("cancel"))}</button>
    </div>
  </div>`;
}

const revealHtml = (r) => `<div class="invite-link a-reveal ai-reveal" role="status">
  <span class="mono">${esc(r.label)}${r.space ? ` · ${esc(r.space)}` : ""} — ${esc(t("adminRevealOnce"))}</span>
  <code>${esc(r.value)}</code>
  <div><button class="text-btn mono" type="button" data-copy="${esc(r.value)}">${esc(t("copy2"))}</button></div>
</div>`;

const SUGGESTIONS = ["aiSuggest1", "aiSuggest2", "aiSuggest3", "aiSuggest4"];

/* ---------- La page ---------- */

let controller = null; // réponse en cours

export async function renderAssistant(main, { id, sub }) {
  controller?.abort();
  controller = null;
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
          <div class="ai-log" id="ai-log" aria-live="polite">
            ${conv ? conv.messages.map(messageHtml).join("") : ""}
          </div>
          <div class="ai-pendings" id="ai-pendings">${conv ? conv.pending.map(pendingHtml).join("") : ""}</div>
          <div class="ai-reveals" id="ai-reveals"></div>
          ${conv ? "" : `<div class="chips ai-suggest">${SUGGESTIONS.map((k) => `<button class="chip" type="button" data-suggest>${esc(t(k))}</button>`).join("")}</div>`}
          <form class="ai-compose" id="ai-form">
            <label class="sr-only" for="ai-input">${esc(t("aiPlaceholder"))}</label>
            <textarea class="input ai-input" id="ai-input" rows="2" maxlength="8000" placeholder="${esc(t("aiPlaceholder"))}"></textarea>
            <button class="btn signal" type="submit" id="ai-send">${esc(t("aiSend"))} →</button>
            <button class="btn ghost" type="button" id="ai-stop" hidden>${esc(t("aiStop"))}</button>
          </form>
          ${conv && (conv.usage.input || conv.usage.output) ? `<p class="mono ai-usage">${esc(t("aiUsage", conv.usage))}</p>` : ""}
        </div>
      </div>
    </section>`;

  if (!info.configured) return;
  const log = $("#ai-log", main);
  const input = $("#ai-input", main);
  const form = $("#ai-form", main);
  const sendBtn = $("#ai-send", main);
  const stopBtn = $("#ai-stop", main);
  let conversationId = conv?.id ?? null;
  /** Fait voir le dernier élément arrivé : une carte (confirmation, valeur à copier) passe avant le texte. */
  const scroll = () => {
    const last = $("#ai-reveals", main).lastElementChild ?? $("#ai-pendings", main).lastElementChild ?? log.lastElementChild;
    last?.scrollIntoView({ block: "end", behavior: "smooth" });
  };

  if (!sub) input.focus({ preventScroll: true });
  scroll();

  /** Affiche un tour de l'Assistant à partir des événements du flux. */
  function consume(target) {
    let msg = null;
    let text = "";
    const ensure = () => {
      if (!msg) {
        msg = document.createElement("div");
        msg.className = "ai-msg assistant";
        msg.innerHTML = `<ul class="ai-tools"></ul><div class="ai-text"><p class="ai-typing" aria-hidden="true"><span></span><span></span><span></span></p></div>`;
        target.append(msg);
      }
      return msg;
    };
    const newTurn = () => {
      msg = null;
      text = "";
    };
    ensure();
    return (ev, data) => {
      switch (ev) {
        case "conversation":
          if (!conversationId) {
            conversationId = data.id;
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
          }
          break;
        case "text":
          text += data.delta;
          $(".ai-text", ensure()).innerHTML = md(text);
          scroll();
          break;
        case "tool_start": {
          // Le texte d'avant un outil appartient à ce tour ; les outils suivants ouvrent un nouveau bloc s'il y a déjà du texte.
          if (text) newTurn();
          const li = document.createElement("li");
          li.className = "ai-tool";
          li.dataset.id = data.id;
          li.innerHTML = `<span class="ai-tool-mark" aria-hidden="true">…</span>${esc(data.label)}`;
          $(".ai-tools", ensure()).append(li);
          scroll();
          break;
        }
        case "tool_end": {
          const li = $(`.ai-tool[data-id="${CSS.escape(data.id)}"]`, log);
          if (li) {
            li.dataset.ok = String(data.ok);
            $(".ai-tool-mark", li).textContent = data.ok ? "✓" : "✕";
            if (!data.ok && data.error) li.title = data.error;
          }
          break;
        }
        case "pending":
          $("#ai-pendings", main).insertAdjacentHTML("beforeend", pendingHtml(data));
          scroll();
          break;
        case "reveal":
          $("#ai-reveals", main).insertAdjacentHTML("beforeend", revealHtml(data));
          scroll();
          break;
        case "decision":
          if (data.status === "failed") toast(data.error ?? errorText("generic"), "error");
          break;
        case "error": {
          const p = document.createElement("p");
          p.className = "error ai-error";
          p.setAttribute("role", "alert");
          p.textContent = data.message ? `${errorText(data.error, data)} — ${data.message}` : errorText(data.error, data);
          log.append(p);
          scroll();
          break;
        }
        default:
          break;
      }
    };
  }

  /** Nettoie les blocs vides (un tour sans texte ni outil) et les points d'attente. */
  const tidy = () => {
    $$(".ai-typing", log).forEach((el) => el.remove());
    $$(".ai-msg.assistant", log).forEach((el) => {
      if (!$(".ai-tool", el) && !$(".ai-text", el)?.textContent.trim()) el.remove();
    });
  };

  async function run(url, body) {
    controller = new AbortController();
    sendBtn.hidden = true;
    stopBtn.hidden = false;
    input.disabled = true;
    $(".ai-suggest", main)?.remove();
    const onEvent = consume(log);
    await stream(url, { ...body, lang }, onEvent, controller.signal);
    tidy();
    controller = null;
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    input.disabled = false;
    input.focus({ preventScroll: true });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || controller) return;
    input.value = "";
    log.insertAdjacentHTML("beforeend", messageHtml({ role: "user", text }));
    scroll();
    await run(`${base}/messages`, { text, conversation: conversationId });
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  stopBtn.addEventListener("click", () => controller?.abort());
  $$("[data-suggest]", main).forEach((b) => b.addEventListener("click", () => {
    input.value = b.textContent;
    form.requestSubmit();
  }));

  $("#ai-pendings", main).addEventListener("click", async (e) => {
    const b = e.target.closest("[data-approve], [data-refuse]");
    if (!b || controller) return;
    const card = b.closest("[data-pending]");
    const approve = b.hasAttribute("data-approve");
    $$("button", card).forEach((x) => { x.disabled = true; });
    card.classList.add("decided");
    log.insertAdjacentHTML("beforeend", messageHtml({ role: "user", kind: approve ? "confirmed" : "refused" }));
    card.remove();
    await run(`${base}/pending/${encodeURIComponent(card.dataset.pending)}`, { approve });
  });

  $("#ai-delete", main)?.addEventListener("click", async () => {
    const ok = await confirmBox({ title: t("aiDeleteTitle"), text: t("aiDeleteText"), ok: t("aiDelete"), danger: true });
    if (!ok) return;
    try {
      await api.del(`${base}/conversations/${encodeURIComponent(conversationId)}`);
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
          <div class="inline-actions"><button class="btn signal" type="submit">${esc(t("save"))}</button></div>
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

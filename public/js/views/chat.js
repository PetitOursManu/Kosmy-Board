/*
 * Le chat de l'Assistant, partagé par la page Assistant (#/assistant) et l'accueil du Board.
 * La réponse arrive en flux (Server-Sent Events). Tout ce qui vient du modèle ou des applis est échappé (esc),
 * puis mis en forme avec un Markdown minimal (paragraphes, listes, gras, code).
 */
import { errorText, lang, t } from "../i18n.js";
import { $, $$, esc, toast } from "../ui.js";

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
  } catch {
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

export function messageHtml(m) {
  if (m.role === "user") {
    if (m.kind) {
      const key = { confirmed: "aiNoteConfirmed", refused: "aiNoteRefused", failed: "aiNoteFailed", report: "aiNoteReport" }[m.kind] ?? "aiNoteConfirmed";
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

export const revealHtml = (r) => `<div class="invite-link a-reveal ai-reveal" role="status">
  <span class="mono">${esc(r.label)}${r.space ? ` · ${esc(r.space)}` : ""} — ${esc(t("adminRevealOnce"))}</span>
  <code>${esc(r.value)}</code>
  <div><button class="text-btn mono" type="button" data-copy="${esc(r.value)}">${esc(t("copy2"))}</button></div>
</div>`;

const SUGGESTIONS = ["aiSuggest1", "aiSuggest2", "aiSuggest3", "aiSuggest4"];
let seq = 0;

/* ---------- Le chat ---------- */

/**
 * Monte un chat dans `root`.
 * - conversation : celle à afficher (avec ses messages et actions en attente), ou null pour une nouvelle ;
 * - compact : version de l'accueil (les messages défilent dans le cadre, pas la page) ;
 * - onConversation({ id, title }) : la conversation vient d'être créée par le premier message ;
 * - autofocus : met le curseur dans le champ.
 * Renvoie { abort() } pour interrompre une réponse en cours.
 */
export function mountChat(root, { conversation = null, compact = false, onConversation = () => {}, autofocus = false } = {}) {
  const uid = `ai-input-${++seq}`;
  root.innerHTML = `
    <div class="ai-scroll">
      <div class="ai-log" aria-live="polite">${conversation ? conversation.messages.map(messageHtml).join("") : ""}</div>
      <div class="ai-pendings">${conversation ? conversation.pending.map(pendingHtml).join("") : ""}</div>
      <div class="ai-reveals"></div>
    </div>
    ${conversation ? "" : `<div class="chips ai-suggest">${SUGGESTIONS.map((k) => `<button class="chip" type="button" data-suggest>${esc(t(k))}</button>`).join("")}</div>`}
    <form class="ai-compose${compact ? " compact" : ""}">
      <label class="sr-only" for="${uid}">${esc(t("aiPlaceholder"))}</label>
      <textarea class="input ai-input" id="${uid}" rows="${compact ? 1 : 2}" maxlength="8000" placeholder="${esc(t("aiPlaceholder"))}"></textarea>
      <button class="btn signal" type="submit" data-send>${esc(t("aiSend"))} →</button>
      <button class="btn ghost" type="button" data-stop hidden>${esc(t("aiStop"))}</button>
    </form>
    ${conversation && (conversation.usage.input || conversation.usage.output) ? `<p class="mono ai-usage">${esc(t("aiUsage", conversation.usage))}</p>` : ""}`;

  const scrollBox = $(".ai-scroll", root);
  const log = $(".ai-log", root);
  const pendings = $(".ai-pendings", root);
  const reveals = $(".ai-reveals", root);
  const input = $(".ai-input", root);
  const form = $(".ai-compose", root);
  const sendBtn = $("[data-send]", root);
  const stopBtn = $("[data-stop]", root);
  let conversationId = conversation?.id ?? null;
  let controller = null;

  /** Fait voir le dernier élément arrivé : une carte (confirmation, valeur à copier) passe avant le texte. */
  const scroll = () => {
    if (compact) {
      scrollBox.scrollTop = scrollBox.scrollHeight;
      return;
    }
    const last = reveals.lastElementChild ?? pendings.lastElementChild ?? log.lastElementChild;
    last?.scrollIntoView({ block: "end", behavior: "smooth" });
  };

  if (autofocus) input.focus({ preventScroll: true });
  scroll();

  /** Affiche un tour de l'Assistant à partir des événements du flux. */
  function consume() {
    let msg = null;
    let text = "";
    const ensure = () => {
      if (!msg) {
        msg = document.createElement("div");
        msg.className = "ai-msg assistant";
        msg.innerHTML = `<ul class="ai-tools"></ul><div class="ai-text"><p class="ai-typing" aria-hidden="true"><span></span><span></span><span></span></p></div>`;
        log.append(msg);
      }
      return msg;
    };
    ensure();
    return (ev, data) => {
      switch (ev) {
        case "conversation":
          if (!conversationId) {
            conversationId = data.id;
            onConversation(data);
          }
          break;
        case "text":
          text += data.delta;
          $(".ai-text", ensure()).innerHTML = md(text);
          scroll();
          break;
        case "tool_start": {
          // Le texte d'avant un outil appartient à ce tour ; les outils suivants ouvrent un nouveau bloc s'il y a déjà du texte.
          if (text) {
            msg = null;
            text = "";
          }
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
          pendings.insertAdjacentHTML("beforeend", pendingHtml(data));
          scroll();
          break;
        case "reveal":
          reveals.insertAdjacentHTML("beforeend", revealHtml(data));
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
    $(".ai-suggest", root)?.remove();
    root.classList.add("has-messages");
    await stream(url, { ...body, lang }, consume(), controller.signal);
    tidy();
    controller = null;
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    input.disabled = false;
    if (root.isConnected) input.focus({ preventScroll: true });
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
  $$("[data-suggest]", root).forEach((b) => b.addEventListener("click", () => {
    input.value = b.textContent;
    form.requestSubmit();
  }));

  pendings.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-approve], [data-refuse]");
    if (!b || controller) return;
    const card = b.closest("[data-pending]");
    const approve = b.hasAttribute("data-approve");
    $$("button", card).forEach((x) => { x.disabled = true; });
    log.insertAdjacentHTML("beforeend", messageHtml({ role: "user", kind: approve ? "confirmed" : "refused" }));
    card.remove();
    await run(`${base}/pending/${encodeURIComponent(card.dataset.pending)}`, { approve });
  });

  if (conversation) root.classList.add("has-messages");
  return {
    abort: () => controller?.abort(),
    get busy() { return Boolean(controller); },
    get conversationId() { return conversationId; },
  };
}

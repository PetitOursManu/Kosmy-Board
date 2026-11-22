/*
 * Appels au fournisseur d'IA, au format OpenAI (/chat/completions), avec appels d'outils et réponse en flux (SSE).
 * Pas de SDK : fetch. Les différences entre fournisseurs sont dans une table, par nom d'hôte (comme dans Mocky),
 * pour qu'une adresse saisie à la main reçoive les mêmes corrections que le préréglage.
 */
import { limits } from "./config.js";

export class AiError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Où vont /chat/completions et /models : une adresse qui finit déjà par une version (/v1, /v1beta/openai…)
 * est gardée telle quelle ; DeepSeek sert ses routes à la racine ; les autres reçoivent /v1.
 */
export function openAiRoot(baseUrl) {
  const u = String(baseUrl || "").replace(/\/+$/, "");
  if (!u) return "";
  if (/\/v\d+(?:beta|alpha)?\d*(?:\/openai)?$/i.test(u) || /\/openai$/i.test(u)) return u;
  try {
    if (new URL(u).hostname === "api.deepseek.com") return u;
  } catch {
    return "";
  }
  return `${u}/v1`;
}

/** Particularités, par nom d'hôte. */
const QUIRKS = [
  { host: /(^|\.)openai\.com$/, maxTokensField: "max_completion_tokens", usage: true },
  { host: /(^|\.)openrouter\.ai$/, usage: true, headers: { "X-Title": "Kosmy Board" } },
  { host: /(^|\.)x\.ai$/, maxTokensField: "max_completion_tokens" },
  { host: /(^|\.)moonshot\.(ai|cn)$/, maxTokensField: "max_completion_tokens" },
];
function quirksFor(root) {
  let host = "";
  try {
    host = new URL(root).hostname;
  } catch { /* adresse invalide : aucune particularité */ }
  return QUIRKS.find((q) => q.host.test(host)) ?? {};
}

function headersFor(target, quirk) {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "User-Agent": "Kosmy-Board",
    ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
    ...(quirk.headers ?? {}),
  };
}

/** Consommation, quel que soit le nom des champs (OpenAI, Anthropic, Groq, OpenRouter et son coût en dollars). */
export function usageOf(raw) {
  const u = raw?.usage ?? raw?.x_groq?.usage;
  if (!u || typeof u !== "object") return null;
  const input = Number(u.prompt_tokens ?? u.input_tokens) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens) || 0;
  const cost = Number.isFinite(Number(u.cost)) ? Number(u.cost) : null;
  return { input, output, ...(cost !== null ? { cost } : {}) };
}

/** Message d'erreur du fournisseur, en texte court. */
function errorText(data, raw) {
  const e = data?.error;
  const msg = typeof e === "string" ? e : e?.message ?? data?.message ?? "";
  return String(msg || raw || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Un tour de conversation. Renvoie { content, toolCalls: [{ id, name, arguments }], usage, finishReason }.
 * `onText(delta)` reçoit le texte au fil de l'eau.
 */
export async function chat(target, { messages, tools, signal, onText }) {
  const root = openAiRoot(target.baseUrl);
  if (!root) throw new AiError("ai_not_configured");
  const quirk = quirksFor(root);
  const body = {
    model: target.model,
    messages,
    stream: true,
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    [quirk.maxTokensField ?? "max_tokens"]: limits.maxTokens,
    ...(quirk.usage ? { stream_options: { include_usage: true } } : {}),
  };
  let res;
  try {
    res = await fetch(`${root}/chat/completions`, {
      method: "POST",
      headers: headersFor(target, quirk),
      body: JSON.stringify(body),
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });
  } catch (e) {
    if (signal?.aborted) throw new AiError("ai_aborted");
    throw new AiError(e?.name === "TimeoutError" ? "ai_timeout" : "ai_unreachable", e?.cause?.message || e?.message);
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(raw); } catch { /* texte brut */ }
    const code = res.status === 401 || res.status === 403 ? "ai_auth" : res.status === 429 ? "ai_rate_limited" : "ai_failed";
    throw new AiError(code, errorText(data, raw.slice(0, 300)), res.status);
  }

  const type = res.headers.get("content-type") || "";
  // Certains serveurs ignorent « stream » : une réponse JSON entière.
  if (!type.includes("text/event-stream")) {
    const data = await res.json().catch(() => null);
    if (!data?.choices?.[0]) throw new AiError("ai_failed", errorText(data, ""));
    const m = data.choices[0].message ?? {};
    if (m.content) onText?.(m.content);
    return {
      content: m.content ?? "",
      toolCalls: (m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments ?? "" })),
      usage: usageOf(data),
      finishReason: data.choices[0].finish_reason ?? null,
    };
  }

  let content = "";
  const calls = []; // par index : { id, name, arguments }
  let usage = null;
  let finishReason = null;
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    // OpenRouter : une erreur peut arriver dans le flux, après un 200.
    if (obj.error) throw new AiError("ai_failed", errorText(obj, ""));
    usage = usageOf(obj) ?? usage;
    const choice = obj.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? choice.message ?? {};
    if (typeof d.content === "string" && d.content) {
      content += d.content;
      onText?.(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const i = Number.isInteger(tc.index) ? tc.index : calls.length;
      const c = (calls[i] ??= { id: "", name: "", arguments: "" });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
    }
    handle(buf.trim());
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (signal?.aborted) throw new AiError("ai_aborted");
    throw new AiError("ai_unreachable", e?.message);
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` })).filter((c) => c.name);
  return { content, toolCalls, usage, finishReason };
}

/** Les modèles du fournisseur. Pour OpenRouter, seulement ceux qui savent appeler des outils. */
export async function listModels(target) {
  const root = openAiRoot(target.baseUrl);
  if (!root) throw new AiError("ai_not_configured");
  const quirk = quirksFor(root);
  let res;
  try {
    res = await fetch(`${root}/models`, { headers: headersFor(target, quirk), redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new AiError(e?.name === "TimeoutError" ? "ai_timeout" : "ai_unreachable", e?.cause?.message || e?.message);
  }
  if (res.status === 404) throw new AiError("ai_no_model_list");
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(raw); } catch { /* texte brut */ }
    throw new AiError(res.status === 401 || res.status === 403 ? "ai_auth" : "ai_failed", errorText(data, raw.slice(0, 300)), res.status);
  }
  const data = await res.json().catch(() => null);
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return list
    .filter((m) => m && typeof (m.id ?? m.name) === "string")
    .filter((m) => !Array.isArray(m.supported_parameters) || m.supported_parameters.includes("tools"))
    .map((m) => ({ id: String(m.id ?? m.name).replace(/^models\//, ""), name: typeof m.name === "string" && m.name !== m.id ? m.name : null }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 1000);
}

/** Vérifie le réglage : une vraie question, avec un outil, pour savoir aussi si le modèle sait appeler des outils. */
export async function testTarget(target) {
  const tools = [{
    type: "function",
    function: { name: "ping", description: "Answer the user's ping.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  }];
  const r = await chat(target, { messages: [{ role: "user", content: "Call the ping tool now." }], tools });
  return { ok: true, tools: r.toolCalls.some((c) => c.name === "ping"), usage: r.usage };
}

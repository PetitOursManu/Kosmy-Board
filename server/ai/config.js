/*
 * Assistant : le fournisseur d'IA (un seul pour tout le Board, réglé par un administrateur).
 *
 * Toutes les API sont appelées au format OpenAI (/chat/completions), comme dans Mocky : OpenRouter, OpenAI,
 * le point d'accès compatible OpenAI d'Anthropic, Gemini, Mistral… ou un modèle local (Ollama, LM Studio).
 * Les variables d'environnement AI_* l'emportent sur le réglage enregistré ; la clé enregistrée est chiffrée
 * (AES-256-GCM) avec une clé maîtresse gardée hors de la base, dans DATA_DIR/secret.key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { meta } from "../db.js";
import { bad } from "../http.js";

/** Préréglages. `noKey` : un serveur local qui n'en demande pas. */
export const PROVIDERS = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api", model: "" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com", model: "" },
  { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "" },
  { id: "mistral", label: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", model: "" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "" },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", model: "" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "" },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.ai/v1", model: "" },
  { id: "fireworks", label: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", model: "" },
  { id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", model: "" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434", model: "", noKey: true },
  { id: "lmstudio", label: "LM Studio (local)", baseUrl: "http://localhost:1234", model: "", noKey: true },
  { id: "custom", label: "Compatible OpenAI", baseUrl: "", model: "", optionalKey: true },
];
const byId = new Map(PROVIDERS.map((p) => [p.id, p]));
export const preset = (id) => byId.get(id) ?? byId.get("custom");

/** Limites, réglables par variables d'environnement. */
export const limits = {
  /** Tours d'outils au plus pour une réponse. */
  maxSteps: Math.min(Math.max(Number(process.env.AI_MAX_STEPS) || 25, 1), 100),
  /** Messages par personne et par heure (chat et MCP confondus pour l'agent du Board). */
  hourly: Math.max(Number(process.env.AI_HOURLY_LIMIT) || 60, 1),
  /** Jetons de sortie par tour. */
  maxTokens: Math.min(Math.max(Number(process.env.AI_MAX_TOKENS) || 4096, 256), 64_000),
};

/* ---------- Chiffrement de la clé ---------- */

let master = null;
function masterKey() {
  if (master) return master;
  const file = path.join(config.dataDir, "secret.key");
  if (existsSync(file)) {
    master = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  } else {
    master = randomBytes(32);
    writeFileSync(file, master.toString("base64"), { mode: 0o600 });
  }
  if (master.length !== 32) throw new Error("DATA_DIR/secret.key invalide");
  return master;
}

export function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}`;
}

export function decrypt(box) {
  if (typeof box !== "string" || !box.startsWith("v1:")) return "";
  try {
    const raw = Buffer.from(box.slice(3), "base64url");
    const d = createDecipheriv("aes-256-gcm", masterKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    // Clé maîtresse changée (secret.key perdu) : la clé enregistrée est illisible, il faut la ressaisir.
    return "";
  }
}

/* ---------- Réglage ---------- */

const ENV = {
  provider: process.env.AI_PROVIDER?.trim() || null,
  baseUrl: process.env.AI_BASE_URL?.trim() || null,
  model: process.env.AI_MODEL?.trim() || null,
  apiKey: process.env.AI_API_KEY?.trim() || null,
};

function stored() {
  try {
    return JSON.parse(meta.get("ai_config") || "{}");
  } catch {
    return {};
  }
}

/** Adresse de base : http(s), sans identifiants, paramètres ni fragment, sans « / » final. */
export function cleanBaseUrl(v) {
  const raw = typeof v === "string" ? v.trim() : "";
  if (!raw) return "";
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw bad("ai_base_url");
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw bad("ai_base_url");
  return u.href.replace(/\/+$/, "");
}

/** Le réglage en vigueur : variables d'environnement, sinon réglage enregistré, sinon préréglage. */
export function aiTarget() {
  const s = stored();
  const provider = ENV.provider ?? s.provider ?? "openrouter";
  const p = preset(provider);
  const baseUrl = ENV.baseUrl ?? (s.baseUrl || p.baseUrl);
  const model = ENV.model ?? (s.model || p.model);
  const apiKey = ENV.apiKey ?? decrypt(s.apiKey);
  const configured = Boolean(baseUrl && model && (apiKey || p.noKey || p.optionalKey));
  return { provider: p.id, label: p.label, baseUrl, model, apiKey, configured };
}

/** Pour l'interface : jamais la clé, seulement si elle existe, et ce qui est imposé par l'environnement. */
export function publicAiConfig() {
  const t = aiTarget();
  return {
    provider: t.provider,
    baseUrl: t.baseUrl,
    model: t.model,
    hasApiKey: Boolean(t.apiKey),
    configured: t.configured,
    env: Object.fromEntries(Object.entries(ENV).map(([k, v]) => [k, v !== null])),
    providers: PROVIDERS.map(({ id, label, baseUrl, model, noKey, optionalKey }) => ({ id, label, baseUrl, model, noKey: Boolean(noKey), optionalKey: Boolean(optionalKey) })),
    limits,
  };
}

/**
 * Enregistre le réglage. `apiKey` : absent ou "" garde la clé actuelle, null l'efface.
 * Changer de fournisseur efface la clé (elle ne vaut que pour l'ancien), sauf si une nouvelle est donnée.
 */
export function saveAiConfig(body) {
  const s = stored();
  const provider = typeof body.provider === "string" && byId.has(body.provider) ? body.provider : s.provider ?? "openrouter";
  const same = provider === s.provider;
  const next = {
    provider,
    // Vide : l'adresse et le modèle du préréglage.
    baseUrl: body.baseUrl === undefined ? (same ? s.baseUrl ?? "" : "") : cleanBaseUrl(body.baseUrl),
    model: body.model === undefined ? (same ? s.model ?? "" : "") : String(body.model ?? "").trim().slice(0, 200),
    apiKey: s.apiKey ?? null,
  };
  if (!same && !body.apiKey) next.apiKey = null;
  if (body.apiKey === null) next.apiKey = null;
  else if (typeof body.apiKey === "string" && body.apiKey.trim()) next.apiKey = encrypt(body.apiKey.trim().slice(0, 500));
  if (provider === "custom" && !next.baseUrl && !ENV.baseUrl) throw bad("ai_base_url");
  meta.set("ai_config", JSON.stringify(next));
  return publicAiConfig();
}

/*
 * Bilans planifiés : chaque jour ou chaque semaine, à l'heure choisie (heure du serveur), l'Assistant fait le tour
 * des instances de la personne en lecture seule, garde le bilan comme conversation, et l'envoie en notification
 * (cloche du Board et Kosmy Mobile).
 */
import { config } from "../config.js";
import { db } from "../db.js";
import { notifyUser } from "../notifications.js";
import { addUserMessage, createConversation, respond } from "./agent.js";
import { aiTarget } from "./config.js";

/** Un bilan manqué (serveur arrêté à l'heure prévue) est encore fait dans les 3 heures qui suivent. */
const CATCH_UP = 3 * 3_600_000;

const PROMPT = {
  fr: "[Bilan planifié] Fais le bilan de santé de toutes mes instances : instances injoignables ou en erreur, alertes (avertissements et dangers), versions des applis, et ce qui mérite mon attention. Commence par une phrase de synthèse, puis une courte liste. Si tout va bien, dis-le simplement.",
  en: "[Scheduled report] Give me a health report of all my instances: unreachable or failing instances, alerts (warnings and dangers), app versions, and what needs my attention. Start with a one-sentence summary, then a short list. If all is well, just say so.",
};

/** Le dernier créneau prévu avant `now` (ou null si le bilan est désactivé). */
export function lastSlot(r, now = new Date()) {
  if (r.frequency === "off") return null;
  const slot = new Date(now);
  slot.setHours(r.hour, 0, 0, 0);
  if (r.frequency === "daily") {
    if (slot > now) slot.setDate(slot.getDate() - 1);
  } else {
    slot.setDate(slot.getDate() - ((slot.getDay() - r.weekday + 7) % 7));
    if (slot > now) slot.setDate(slot.getDate() - 7);
  }
  return slot.getTime();
}

/** Texte brut et court pour la notification. */
function plain(text, max = 600) {
  const s = String(text || "").replace(/\*\*|`/g, "").replace(/^\s*[-*•]\s+/gm, "• ").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Fait un bilan maintenant pour cette personne. Renvoie l'identifiant de la conversation. */
export async function runReport(user) {
  db.prepare("UPDATE ai_reports SET last_run_at = ? WHERE user_id = ?").run(Date.now(), user.id);
  const lang = user.lang === "en" ? "en" : "fr";
  const date = new Date().toLocaleDateString(lang === "en" ? "en-GB" : "fr-FR", { day: "numeric", month: "long" });
  const conversationId = createConversation(user.id, lang === "en" ? `Report of ${date}` : `Bilan du ${date}`, "report");
  addUserMessage(conversationId, PROMPT[lang], "report");
  let text;
  try {
    text = await respond({ user, lang, conversationId, mode: "readonly", channel: "report" });
  } catch (e) {
    text = lang === "en" ? `The report failed (${e.code ?? "error"}).` : `Le bilan n'a pas pu être fait (${e.code ?? "erreur"}).`;
  }
  notifyUser(user.id, {
    title: lang === "en" ? "Report on your instances" : "Bilan de vos instances",
    body: plain(text),
    url: `${config.publicUrl}/#/assistant/${conversationId}`,
  });
  return conversationId;
}

let running = false;

/** Appelé chaque minute : lance, l'un après l'autre, les bilans dont l'heure est venue. */
export async function runDueReports(now = new Date()) {
  if (running || !aiTarget().configured) return;
  running = true;
  try {
    const rows = db.prepare("SELECT r.*, u.id AS uid FROM ai_reports r JOIN users u ON u.id = r.user_id WHERE r.frequency <> 'off'").all();
    for (const r of rows) {
      const slot = lastSlot(r, now);
      if (slot === null || now.getTime() - slot > CATCH_UP || (r.last_run_at ?? 0) >= slot) continue;
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(r.user_id);
      if (!user) continue;
      await runReport(user).catch((e) => console.error("Bilan :", e));
    }
  } finally {
    running = false;
  }
}

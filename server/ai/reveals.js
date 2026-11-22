/*
 * Valeurs à montrer une seule fois (mot de passe temporaire, lien d'invitation, secret client) produites
 * par un outil appelé depuis le MCP : elles ne passent pas par le modèle. Le Board les garde en mémoire
 * 15 minutes, le temps que la personne ouvre le lien (connectée au Board) ; la première lecture les efface.
 */
import { randomBytes } from "node:crypto";

import { config } from "../config.js";

const TTL = 15 * 60_000;
const store = new Map(); // id → { userId, label, value, space, exp }

export function keepReveal(userId, { label, value, space }) {
  const now = Date.now();
  for (const [k, v] of store) if (v.exp < now) store.delete(k);
  const id = randomBytes(18).toString("base64url");
  store.set(id, { userId, label, value, space: space ?? null, exp: now + TTL });
  return { id, url: `${config.publicUrl}/#/valeur/${id}`, expiresAt: now + TTL };
}

/** Lue une fois, par la personne à qui elle appartient. */
export function takeReveal(userId, id) {
  const r = store.get(id);
  if (!r || r.userId !== userId || r.exp < Date.now()) return null;
  store.delete(id);
  return { label: r.label, value: r.value, space: r.space };
}

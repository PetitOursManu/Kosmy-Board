/*
 * Statut des instances, vérifié depuis le navigateur : une requête « no-cors » sans cookies.
 * Toute réponse (même 401 ou 404) veut dire « joignable ». C'est une indication, pas un contrôle d'accès.
 */
import { hostOf, isCleartext, isLocalHost } from "./normalize.js";

const TIMEOUT = 6000;
const cache = new Map(); // url → { state, at, promise }
const listeners = new Set();

/** Une page https ne peut pas appeler une adresse http (contenu mixte), sauf sur la machine elle-même. */
export function checkable(url) {
  if (location.protocol !== "https:" || !isCleartext(url)) return true;
  const host = hostOf(url).replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export async function probe(url) {
  if (!checkable(url)) return "unknown";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", credentials: "omit", redirect: "follow", signal: ctrl.signal, referrerPolicy: "no-referrer" });
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

export const getStatus = (url) => cache.get(url)?.state ?? null;
export const onStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** Vérifie une adresse (résultat gardé une minute, sauf si force). */
export function check(url, force = false) {
  const hit = cache.get(url);
  if (hit && !force && (hit.promise || Date.now() - hit.at < 60_000)) return hit.promise ?? Promise.resolve(hit.state);
  const entry = { state: "checking", at: Date.now(), promise: null };
  cache.set(url, entry);
  listeners.forEach((fn) => fn(url, "checking"));
  entry.promise = probe(url).then((state) => {
    Object.assign(entry, { state, at: Date.now(), promise: null });
    listeners.forEach((fn) => fn(url, state));
    return state;
  });
  return entry.promise;
}

export { isLocalHost };

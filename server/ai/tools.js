/*
 * Les outils de l'Assistant, communs au chat du Board, au serveur MCP et aux bilans planifiés.
 *
 * Chaque outil agit au nom de la personne (ctx.user) avec les règles des routes /api (server/spaces.js) :
 * elle ne voit que les instances auxquelles elle a accès (toutes pour un administrateur du Board),
 * et chaque appli revérifie ses droits (jeton kb-admin+jwt).
 *
 * Garde-fous (voir docs/assistant.md) :
 * - une action d'appli marquée « danger » ou « confirm », et les opérations du Board qui suppriment ou coupent
 *   quelque chose, passent par ctx.onDanger : le chat les met en attente de confirmation, le MCP exige l'outil
 *   « dangereux » (que le client fait approuver), les bilans ne les ont pas du tout ;
 * - une action n'est envoyée que si elle existe dans la section relue juste avant ;
 * - le modèle ne remplit jamais un champ « password » ;
 * - une valeur à montrer une fois (« reveal » : mot de passe temporaire, lien d'invitation, secret client)
 *   ne repart jamais vers le modèle : elle va directement à la personne (ctx.reveal).
 */
import { readFileSync } from "node:fs";

import { cleanActionInput, cleanManifest, cleanResult, cleanSection } from "../admin.js";
import { db } from "../db.js";
import { HttpError } from "../http.js";
import {
  appCall, createInvite, createSpace, deleteSpace, disableSso, enableSso, getSpace, getSso, kosmyDefaults, listMembers,
  listSpaceRows, rotateSsoSecret, sectionId, spaceForAdmin, updateSpace,
} from "../spaces.js";
import { appSchema, createUser, instanceAccessList, removeUser, revokeAccess, setAccess, userAccessList } from "../access.js";

/* ---------- Petits outils ---------- */

const CATALOG = (() => {
  try {
    const c = JSON.parse(readFileSync(new URL("../../public/js/catalog-fallback.json", import.meta.url), "utf8"));
    return new Map((c.apps ?? []).map((a) => [a.id, { name: a.name, adminPath: a.admin?.path ?? "/" }]));
  } catch {
    return new Map();
  }
})();

/** Erreur montrée au modèle, qui peut corriger sa demande. */
class ToolError extends Error {
  constructor(message) {
    super(message);
    this.toolError = true;
  }
}

/** Exécute fn sur chaque élément, `n` à la fois. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

/** Message lisible pour une erreur du Board ou de l'appli. */
export function errorMessage(e) {
  if (e?.toolError) return e.message;
  if (e instanceof HttpError) {
    const app = e.extra?.message ? ` — ${e.extra.message}` : "";
    const known = {
      not_found: "unknown space or item",
      admin_no_sso: "single sign-on is not enabled for this space, so its admin is not available from the Board",
      admin_unsupported: "this app does not offer the admin in the Board (protocol kosmy.board-admin.v1)",
      admin_unreachable: "the Board server cannot reach this instance",
      admin_timeout: "the instance did not answer in time",
      admin_rejected: "the app rejected the Board's token (check its single sign-on settings)",
      admin_not_linked: "the person's Board account is not linked to an account of this app (sign in once through the Board)",
      admin_forbidden: "the linked account is not an administrator of this app",
      admin_not_found: "unknown section, row or action",
      admin_app_error: "the app refused",
      admin_app_failed: "the app failed",
      admin_invalid: "the app sent an invalid answer",
      sso_enabled: "single sign-on is already enabled",
      sso_disabled: "single sign-on is not enabled",
      sso_manage: "only a Board administrator can change this",
      self: "you cannot do this to your own account",
      too_many: "too many spaces",
      admin: "Board administrators only",
      space_exists: "an instance with this address is already in the Board",
      access_no_sso: "single sign-on is not enabled for this instance, so its accounts cannot be managed from the Board",
      users_unsupported: "this app does not let the Board manage its accounts (protocol kosmy.board-users.v1); give access without a role",
      users_invalid: "the app sent an invalid list of roles",
      access_role: "unknown role for this app: call get_app_roles",
      access_values: "a restriction value is not valid: call get_app_roles",
      email_taken: "this e-mail address is already used by a Board account",
    };
    return `${known[e.code] ?? e.code}${app}`;
  }
  return "unexpected error";
}

/** Retrouve un membre du Board par son identifiant ou son e-mail. */
function resolveMember(ref) {
  const r = String(ref ?? "").trim().toLowerCase();
  const m = listMembers().users.find((u) => u.id === ref || u.email.toLowerCase() === r);
  if (!m) throw new ToolError("unknown member. Call list_members.");
  return m;
}

/** Retrouve un espace de la personne par son identifiant ou son nom (sans tenir compte de la casse). */
function resolveSpace(user, ref) {
  const r = String(ref ?? "").trim();
  if (!r) throw new ToolError("missing 'space'");
  const byId = getSpace(user, r);
  if (byId) return byId;
  const rows = listSpaceRows(user);
  const lower = r.toLowerCase();
  const exact = rows.filter((s) => s.name.toLowerCase() === lower);
  const found = exact.length ? exact : rows.filter((s) => s.name.toLowerCase().includes(lower) || s.base.toLowerCase().includes(lower));
  if (found.length === 1) return found[0];
  if (!found.length) throw new ToolError(`no space matches "${r}". Call list_spaces.`);
  throw new ToolError(`several spaces match "${r}": ${found.map((s) => `${s.name} (id ${s.id})`).join(", ")}. Use the id.`);
}

const spaceBrief = (s) => ({
  id: s.id, name: s.name, app: s.app_id ? CATALOG.get(s.app_id)?.name ?? s.app_id : null, url: s.base, adminPath: s.path,
  singleSignOn: Boolean(s.client_id), boardAdmin: Boolean(s.client_id),
  ...(s.access_role ? { yourRole: s.access_label || s.access_role } : {}),
});

/* ---------- Sections : forme compacte pour le modèle ---------- */

const cellText = (v) => (v && typeof v === "object" ? `${v.text}${v.tone ? ` [${v.tone}]` : ""}` : v);
const fieldBrief = (f) => ({
  name: f.name, label: f.label, type: f.type,
  ...(f.type === "password" ? { note: "password: you cannot fill it" } : f.value !== undefined ? { value: f.value } : {}),
  ...(f.options ? { options: f.options.map((o) => (o.value === o.label ? o.value : `${o.value} (${o.label})`)) } : {}),
  ...(f.required ? { required: true } : {}),
  ...(f.readOnly ? { readOnly: true } : {}),
  ...(f.help ? { help: f.help } : {}),
  ...(f.min !== undefined ? { min: f.min } : {}),
  ...(f.max !== undefined ? { max: f.max } : {}),
});
const actionBrief = (a) => ({
  id: a.id, label: a.label,
  ...(a.description ? { description: a.description } : {}),
  ...(a.danger || a.confirm ? { needsConfirmation: true } : {}),
  ...(a.confirm ? { confirm: a.confirm } : {}),
  ...(a.fields ? { fields: a.fields.map(fieldBrief) } : {}),
});

const MAX_ROWS = 100;
export function compactSection(section) {
  return {
    id: section.id,
    ...(section.title ? { title: section.title } : {}),
    ...(section.description ? { description: section.description } : {}),
    blocks: section.blocks.map((b) => {
      switch (b.type) {
        case "notice": return { type: "notice", tone: b.tone, ...(b.title ? { title: b.title } : {}), text: b.text };
        case "stats":
        case "fields": return { type: b.type, ...(b.title ? { title: b.title } : {}), items: b.items };
        case "form": return {
          type: "form", action: b.action, ...(b.title ? { title: b.title } : {}), ...(b.description ? { description: b.description } : {}),
          fields: b.fields.map(fieldBrief),
        };
        case "table": return {
          type: "table", ...(b.title ? { title: b.title } : {}), ...(b.description ? { description: b.description } : {}),
          columns: Object.fromEntries(b.columns.map((c) => [c.key, c.label])),
          rows: b.rows.slice(0, MAX_ROWS).map((r) => ({
            id: r.id, ...Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, cellText(v)])),
            ...(r.actions ? { actions: r.actions } : {}),
          })),
          ...(b.rows.length > MAX_ROWS ? { totalRows: b.rows.length, note: `only the first ${MAX_ROWS} rows are shown` } : {}),
          ...(b.rowActions ? { rowActions: b.rowActions.map(actionBrief) } : {}),
          ...(b.actions ? { tableActions: b.actions.map(actionBrief) } : {}),
          ...(!b.rows.length && b.empty ? { empty: b.empty } : {}),
        };
        case "actions": return { type: "actions", ...(b.title ? { title: b.title } : {}), items: b.items.map(actionBrief) };
        default: return null;
      }
    }).filter(Boolean),
  };
}

/** Où est définie cette action dans la section : formulaire, action de ligne, de tableau ou bouton. */
function findAction(section, actionId, rowId) {
  for (const b of section.blocks) {
    if (b.type === "form" && b.action === actionId) return { kind: "form", def: { id: b.action, label: b.title || b.submit || b.action }, fields: b.fields };
    if (b.type === "table") {
      const ra = b.rowActions?.find((a) => a.id === actionId);
      if (ra) {
        if (!rowId) throw new ToolError(`action "${actionId}" applies to a row: give 'row' (a row id).`);
        const row = b.rows.find((r) => r.id === rowId);
        if (!row) throw new ToolError(`no row "${rowId}" in this table.`);
        if (!row.actions?.includes(actionId)) throw new ToolError(`action "${actionId}" is not available for row "${rowId}" (available: ${(row.actions ?? []).join(", ") || "none"}).`);
        return { kind: "row", def: ra, fields: ra.fields ?? [], row };
      }
      const ta = b.actions?.find((a) => a.id === actionId);
      if (ta) return { kind: "table", def: ta, fields: ta.fields ?? [] };
    }
    if (b.type === "actions") {
      const a = b.items.find((x) => x.id === actionId);
      if (a) return { kind: "button", def: a, fields: a.fields ?? [] };
    }
  }
  return null;
}

/**
 * Valeurs envoyées à l'appli : celles du modèle, complétées comme le ferait l'interface du Board
 * (formulaire : toutes ses valeurs actuelles ; action : valeurs de la ligne, puis valeurs par défaut).
 * Les champs « password » partent toujours vides, les champs en lecture seule jamais.
 */
function buildValues(found, given) {
  if (given !== undefined && (!given || typeof given !== "object" || Array.isArray(given))) throw new ToolError("'values' must be an object.");
  const fields = found.fields ?? [];
  if (!fields.length) return undefined;
  const known = new Map(fields.map((f) => [f.name, f]));
  for (const k of Object.keys(given ?? {})) {
    if (!known.has(k)) throw new ToolError(`unknown field "${k}". Fields: ${fields.map((f) => f.name).join(", ")}.`);
    if (known.get(k).readOnly) throw new ToolError(`field "${k}" is read-only.`);
  }
  const out = {};
  for (const f of fields) {
    if (f.readOnly) continue;
    if (f.type === "password") {
      out[f.name] = "";
      continue;
    }
    let v = given?.[f.name];
    if (v === undefined) v = found.row?.values?.[f.name];
    if (v === undefined) v = f.value;
    if (v === undefined) v = f.type === "checkbox" ? false : "";
    if (f.type === "checkbox") v = v === true || v === "true";
    else if (f.type === "number") {
      if (v === "" || v === null) v = "";
      else {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new ToolError(`field "${f.name}" must be a number.`);
        v = n;
      }
    } else v = String(v);
    if (f.type === "select" && v !== "" && !f.options.some((o) => o.value === v)) {
      throw new ToolError(`field "${f.name}" must be one of: ${f.options.map((o) => o.value).join(", ")}.`);
    }
    if (f.required && (v === "" || v === false) && f.type !== "checkbox") throw new ToolError(`field "${f.name}" is required.`);
    out[f.name] = v;
  }
  return out;
}

/* ---------- Journal ---------- */

export function audit(ctx, { tool, space, detail, ok, message }) {
  db.prepare(
    "INSERT INTO ai_audit (user_id, channel, tool, space_id, space_name, detail, ok, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(ctx.user.id, ctx.channel, tool, space?.id ?? null, space?.name ?? null, detail ? JSON.stringify(detail).slice(0, 2000) : null,
    ok ? 1 : 0, message ? String(message).slice(0, 500) : null, Date.now());
  db.prepare("DELETE FROM ai_audit WHERE user_id = ? AND id NOT IN (SELECT id FROM ai_audit WHERE user_id = ? ORDER BY id DESC LIMIT 1000)")
    .run(ctx.user.id, ctx.user.id);
}

/** Exécute une opération qui modifie quelque chose, et l'inscrit au journal (réussite ou échec). */
async function logged(ctx, tool, space, detail, fn) {
  try {
    const out = await fn();
    audit(ctx, { tool, space, detail, ok: true, message: out?.message });
    return out;
  } catch (e) {
    audit(ctx, { tool, space, detail, ok: false, message: errorMessage(e) });
    throw e;
  }
}

/**
 * Garde-fou des opérations dangereuses. Renvoie null pour continuer, ou le résultat à rendre au modèle
 * (« en attente de confirmation », « utilisez l'outil dangereux »…). ctx.approved : la personne a déjà validé.
 */
async function gate(ctx, info) {
  if (ctx.approved) return null;
  return ctx.onDanger(info);
}

/* ---------- Les outils ---------- */

const S = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const SPACE = { type: "string", description: "Space id (preferred) or name, from list_spaces." };

async function adminSection(ctx, space, section) {
  return cleanSection(await appCall(ctx.user, space, ctx.lang, { section }), space.base, section);
}

/** Exécute une action d'appli déjà vérifiée. */
async function sendAction(ctx, space, section, input, label) {
  return logged(ctx, "run_admin_action", space, { section, action: input.action, row: input.row, label }, async () => {
    const data = await appCall(ctx.user, space, ctx.lang, { method: "POST", section, body: input });
    const r = cleanResult(data, space.base, section);
    if (r.reveal) ctx.reveal({ ...r.reveal, space: space.name });
    const failed = r.tone === "warning" || r.tone === "danger";
    return {
      ok: !failed,
      ...(r.message ? { message: r.message } : {}),
      ...(r.reveal ? { reveal: `"${r.reveal.label}" was shown to the person (not to you).` } : {}),
      ...(r.section ? { section: compactSection(r.section) } : {}),
    };
  });
}

async function runAdminAction(ctx, args, { dangerousTool = false } = {}) {
  const space = spaceForAdmin(ctx.user, resolveSpace(ctx.user, args.space).id);
  const section = sectionId(String(args.section ?? ""));
  const actionId = String(args.action ?? "");
  const rowId = args.row === undefined || args.row === null || args.row === "" ? undefined : String(args.row);
  // L'action doit exister dans la section telle que l'appli la décrit maintenant.
  const current = await adminSection(ctx, space, section);
  const found = findAction(current, actionId, rowId);
  if (!found) throw new ToolError(`no action "${actionId}" in section "${section}". Read the section with get_admin_section first.`);
  const values = buildValues(found, args.values);
  const input = cleanActionInput({ action: actionId, ...(found.kind === "row" ? { row: rowId } : {}), ...(values ? { values } : {}) });
  const danger = Boolean(found.def.danger || found.def.confirm);
  const label = found.def.label;
  if (danger) {
    const stop = await gate(ctx, {
      tool: "run_admin_action",
      args: { space: space.id, section, action: actionId, ...(input.row ? { row: input.row } : {}), ...(args.values ? { values: args.values } : {}) },
      title: label,
      space: space.name,
      confirm: found.def.confirm ?? null,
      danger: Boolean(found.def.danger),
      values: values ? Object.fromEntries(Object.entries(values).filter(([k]) => args.values && k in args.values)) : null,
      row: found.row ? Object.values(found.row.cells).map(cellText).filter((x) => x !== "" && typeof x !== "boolean").slice(0, 3).join(" · ") : null,
      dangerousTool,
    });
    if (stop) return stop;
  }
  return sendAction(ctx, space, section, input, label);
}

/**
 * Définition : { name, description, parameters, readOnly, dangerous (toujours soumis à confirmation),
 * admin (administrateurs du Board seulement), run(ctx, args) }.
 */
export const TOOLS = [
  /* ----- Vue d'ensemble ----- */
  {
    name: "list_spaces",
    description: "List the person's spaces in Kosmy Board: each self-hosted app instance, its address, and whether single sign-on (and so the admin from the Board) is enabled.",
    parameters: S({}),
    readOnly: true,
    run: (ctx) => ({ spaces: listSpaceRows(ctx.user).map(spaceBrief) }),
  },
  {
    name: "check_status",
    description: "Check whether instances answer over the network (from the Board server). Without 'spaces', checks all of them.",
    parameters: S({ spaces: { type: "array", items: { type: "string" }, description: "Space ids or names (optional)." } }),
    readOnly: true,
    run: async (ctx, args) => {
      const rows = Array.isArray(args.spaces) && args.spaces.length ? args.spaces.map((r) => resolveSpace(ctx.user, r)) : listSpaceRows(ctx.user);
      const results = await pool(rows, 6, async (s) => {
        const t0 = Date.now();
        try {
          const res = await fetch(`${s.base}${s.path}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Kosmy-Board" } });
          res.body?.cancel().catch(() => {});
          return { space: s.name, id: s.id, reachable: true, httpStatus: res.status, ms: Date.now() - t0 };
        } catch (e) {
          return { space: s.name, id: s.id, reachable: false, error: e?.name === "TimeoutError" ? "timeout" : e?.cause?.code || "network error" };
        }
      });
      return { results };
    },
  },
  {
    name: "fleet_overview",
    description: "Overview of every instance with the admin from the Board: app name and version, the person's role in the app, its sections, and the first section's alerts (notices) and figures. Use it for cross-instance questions.",
    parameters: S({}),
    readOnly: true,
    run: async (ctx) => {
      const rows = listSpaceRows(ctx.user);
      const instances = await pool(rows, 4, async (s) => {
        if (!s.client_id) return { space: s.name, id: s.id, boardAdmin: false, note: "single sign-on off: no admin from the Board" };
        try {
          const m = cleanManifest(await appCall(ctx.user, s, ctx.lang));
          const first = await adminSection(ctx, s, m.sections[0].id).catch(() => null);
          const alerts = first?.blocks.filter((b) => b.type === "notice" && b.tone !== "info").map((b) => ({ tone: b.tone, title: b.title, text: b.text })) ?? [];
          const stats = first?.blocks.filter((b) => b.type === "stats").flatMap((b) => b.items) ?? [];
          return {
            space: s.name, id: s.id, app: m.app.name ?? null, version: m.app.version ?? null, role: m.user?.role ?? null,
            sections: m.sections.map((x) => `${x.id} (${x.title})`), alerts, stats,
          };
        } catch (e) {
          return { space: s.name, id: s.id, error: errorMessage(e) };
        }
      });
      return { instances };
    },
  },

  /* ----- Admin des instances ----- */
  {
    name: "get_admin_summary",
    description: "The admin summary of one instance: app, version, the person's role, and the list of admin sections.",
    parameters: S({ space: SPACE }, ["space"]),
    readOnly: true,
    run: async (ctx, args) => {
      const space = spaceForAdmin(ctx.user, resolveSpace(ctx.user, args.space).id);
      return { space: space.name, ...cleanManifest(await appCall(ctx.user, space, ctx.lang)) };
    },
  },
  {
    name: "get_admin_section",
    description: "Read one admin section of an instance: notices, figures, forms (with current values), tables (rows and the actions available on each row) and buttons. Always read a section before acting in it.",
    parameters: S({ space: SPACE, section: { type: "string", description: "Section id, from get_admin_summary." } }, ["space", "section"]),
    readOnly: true,
    run: async (ctx, args) => {
      const space = spaceForAdmin(ctx.user, resolveSpace(ctx.user, args.space).id);
      const section = sectionId(String(args.section ?? ""));
      return { space: space.name, section: compactSection(await adminSection(ctx, space, section)) };
    },
  },
  {
    name: "run_admin_action",
    description: "Run an action in an instance's admin section: submit a form (action = the form's 'action', values = only the fields to change), a row action (with 'row'), a table action, or a button. Actions with needsConfirmation are put on hold until the person confirms them. You cannot fill password fields.",
    parameters: S({
      space: SPACE,
      section: { type: "string" },
      action: { type: "string", description: "Action id, exactly as in the section." },
      row: { type: "string", description: "Row id, for a row action." },
      values: { type: "object", description: "Field values by field name.", additionalProperties: true },
    }, ["space", "section", "action"]),
    run: (ctx, args) => runAdminAction(ctx, args),
  },
  {
    name: "run_dangerous_admin_action",
    mcpOnly: true,
    dangerous: true,
    description: "Same as run_admin_action, for actions marked needsConfirmation (deleting, resetting…). Only call it after the person has explicitly agreed to this exact action.",
    parameters: S({
      space: SPACE,
      section: { type: "string" },
      action: { type: "string" },
      row: { type: "string" },
      values: { type: "object", additionalProperties: true },
    }, ["space", "section", "action"]),
    run: (ctx, args) => runAdminAction(ctx, args, { dangerousTool: true }),
  },

  /* ----- Gestion du Board ----- */
  {
    name: "add_space",
    admin: true,
    description: "Add an instance to the Board (shared: Board administrators see it, others only once given access). For a Kosmy app, give appId (calendy, cleardoc, crafty, dashy, kanby, lumy, mocky, soundy…): its admin path is filled in.",
    parameters: S({
      name: { type: "string" },
      url: { type: "string", description: "Instance address, e.g. https://kanby.example.com" },
      appId: { type: "string" },
      adminPath: { type: "string", description: "Admin page path (optional)." },
    }, ["name", "url"]),
    run: (ctx, args) => logged(ctx, "add_space", null, { name: args.name, url: args.url }, () => {
      const appId = args.appId ? String(args.appId).toLowerCase() : null;
      const s = createSpace(ctx.user, { name: args.name, base: args.url, appId, path: args.adminPath || CATALOG.get(appId)?.adminPath || "/" });
      return { ok: true, message: `Space added: ${s.name}`, space: spaceBrief(s) };
    }),
  },
  {
    name: "update_space",
    admin: true,
    description: "Rename a space or change its address or admin path. Changing the address turns its single sign-on off.",
    parameters: S({ space: SPACE, name: { type: "string" }, url: { type: "string" }, adminPath: { type: "string" } }, ["space"]),
    run: (ctx, args) => {
      const old = resolveSpace(ctx.user, args.space);
      return logged(ctx, "update_space", old, { name: args.name, url: args.url, adminPath: args.adminPath }, () => {
        const s = updateSpace(ctx.user, old.id, {
          appId: old.app_id, name: args.name ?? old.name, base: args.url ?? old.base, path: args.adminPath ?? old.path,
        });
        return { ok: true, message: "Space updated.", space: spaceBrief(s) };
      });
    },
  },
  {
    name: "delete_space",
    admin: true,
    dangerous: true,
    description: "Remove an instance from the Board, for everyone (the instance itself and its accounts are not touched). Needs the person's confirmation.",
    parameters: S({ space: SPACE }, ["space"]),
    run: async (ctx, args) => {
      const s = resolveSpace(ctx.user, args.space);
      const stop = await gate(ctx, { tool: "delete_space", args: { space: s.id }, title: "Remove the space from the Board", space: s.name, danger: true, board: true });
      if (stop) return stop;
      return logged(ctx, "delete_space", s, null, () => {
        deleteSpace(ctx.user, s.id);
        return { ok: true, message: `Space removed: ${s.name}` };
      });
    },
  },
  {
    name: "get_sso",
    admin: true,
    description: "Single sign-on settings of a space: whether it is enabled, the issuer and client id to set in the app, redirect addresses.",
    parameters: S({ space: SPACE }, ["space"]),
    readOnly: true,
    run: (ctx, args) => {
      const s = resolveSpace(ctx.user, args.space);
      const sso = getSso(ctx.user, s.id);
      delete sso.secret;
      return { space: s.name, ...sso };
    },
  },
  {
    name: "enable_sso",
    admin: true,
    description: "Enable single sign-on for a space (needed for the admin from the Board). For a Kosmy app the addresses are filled in. The client secret is shown to the person, who pastes the settings into the app.",
    parameters: S({
      space: SPACE,
      redirectUri: { type: "string", description: "Optional for Kosmy apps." },
      initiateLoginUri: { type: "string" },
    }, ["space"]),
    run: (ctx, args) => {
      const s = resolveSpace(ctx.user, args.space);
      return logged(ctx, "enable_sso", s, null, async () => {
        const d = s.app_id ? kosmyDefaults(s.base) : {};
        const redirect = args.redirectUri || d.redirectUri;
        const { sso } = await enableSso(ctx.user, s.id, { redirectUris: redirect ? [redirect] : [], initiateLoginUri: args.initiateLoginUri || d.initiateLoginUri || "" });
        if (sso.secret) ctx.reveal({ label: "Client secret", value: sso.secret, space: s.name });
        const out = { ...sso };
        if (out.secret) out.secret = "shown to the person (not to you)";
        return { ok: true, message: "Single sign-on enabled.", ...out };
      });
    },
  },
  {
    name: "disable_sso",
    admin: true,
    dangerous: true,
    description: "Turn single sign-on off for a space (the admin from the Board stops working for it). Needs the person's confirmation.",
    parameters: S({ space: SPACE }, ["space"]),
    run: async (ctx, args) => {
      const s = resolveSpace(ctx.user, args.space);
      const stop = await gate(ctx, { tool: "disable_sso", args: { space: s.id }, title: "Turn single sign-on off", space: s.name, danger: true, board: true });
      if (stop) return stop;
      return logged(ctx, "disable_sso", s, null, () => {
        disableSso(ctx.user, s.id);
        return { ok: true, message: "Single sign-on turned off." };
      });
    },
  },
  {
    name: "rotate_sso_secret",
    admin: true,
    dangerous: true,
    description: "Generate a new single sign-on client secret for an instance: the old one stops working at once, until the new one is pasted into the app. Needs the person's confirmation.",
    parameters: S({ space: SPACE }, ["space"]),
    run: async (ctx, args) => {
      const s = resolveSpace(ctx.user, args.space);
      const stop = await gate(ctx, { tool: "rotate_sso_secret", args: { space: s.id }, title: "New client secret (the old one stops working)", space: s.name, danger: true, board: true });
      if (stop) return stop;
      return logged(ctx, "rotate_sso_secret", s, null, () => {
        const sso = rotateSsoSecret(ctx.user, s.id);
        ctx.reveal({ label: "Client secret", value: sso.secret, space: s.name });
        return { ok: true, message: "New client secret created and shown to the person (not to you)." };
      });
    },
  },
  {
    name: "list_members",
    admin: true,
    description: "Members of this Kosmy Board and pending invitations (Board administrators only).",
    parameters: S({}),
    readOnly: true,
    run: () => listMembers(),
  },
  {
    name: "invite_member",
    admin: true,
    description: "Create an invitation link to Kosmy Board (valid 7 days). The link is shown to the person, who sends it.",
    parameters: S({ role: { type: "string", enum: ["member", "admin"] } }),
    run: (ctx, args) => logged(ctx, "invite_member", null, { role: args.role }, () => {
      const inv = createInvite(ctx.user, args.role);
      ctx.reveal({ label: "Invitation link", value: inv.url });
      return { ok: true, message: "Invitation created; the link was shown to the person (not to you).", expiresAt: new Date(inv.expiresAt).toISOString() };
    }),
  },
  {
    name: "remove_member",
    admin: true,
    dangerous: true,
    description: "Delete a member's Board account. Their accounts managed by the Board in the apps are deactivated first. Needs the person's confirmation.",
    parameters: S({ member: { type: "string", description: "Member id or e-mail, from list_members." } }, ["member"]),
    run: async (ctx, args) => {
      const ref = String(args.member ?? "").trim().toLowerCase();
      const m = listMembers().users.find((u) => u.id === args.member || u.email.toLowerCase() === ref);
      if (!m) throw new ToolError("unknown member. Call list_members.");
      if (m.id === ctx.user.id) throw new ToolError("you cannot remove your own account.");
      const stop = await gate(ctx, { tool: "remove_member", args: { member: m.id }, title: `Delete the Board account of ${m.name} (${m.email})`, danger: true, board: true });
      if (stop) return stop;
      return logged(ctx, "remove_member", null, { member: m.email }, async () => {
        const r = await removeUser(ctx.user, m.id, ctx.lang);
        return {
          ok: true, message: `Account deleted: ${m.email}`,
          ...(r.warnings.length ? { notDeactivatedIn: r.warnings.map((w) => `${w.space}: ${errorMessage(new HttpError(502, w.code, w.message ? { message: w.message } : undefined))}`) } : {}),
        };
      });
    },
  },

  {
    name: "create_member",
    admin: true,
    description: "Create a Board account for someone (name, e-mail, Board role). An activation link to choose their password is shown to the person (not to you), who sends it. Then give access to instances with set_user_access.",
    parameters: S({
      name: { type: "string" },
      email: { type: "string" },
      role: { type: "string", enum: ["member", "admin"], description: "Board role. Board administrators see and manage every instance." },
    }, ["name", "email"]),
    run: (ctx, args) => logged(ctx, "create_member", null, { email: args.email, role: args.role }, () => {
      const r = createUser(ctx.user, args);
      ctx.reveal({ label: `Activation link for ${r.user.email}`, value: r.link.url });
      return { ok: true, message: `Account created: ${r.user.email}; the activation link was shown to the person (not to you).`, member: { id: r.user.id, email: r.user.email } };
    }),
  },
  {
    name: "get_user_access",
    admin: true,
    description: "Which instances a Board member can access, with their role and restrictions in each app, and whether the app is in sync.",
    parameters: S({ member: { type: "string", description: "Member id or e-mail, from list_members." } }, ["member"]),
    readOnly: true,
    run: (ctx, args) => {
      const m = resolveMember(args.member);
      return {
        member: { id: m.id, name: m.name, email: m.email, boardRole: m.role },
        instances: userAccessList(m.id).map(({ space, access }) => ({
          space: space.name, id: space.id, singleSignOn: space.sso,
          access: access ? (access.revoked ? "removal pending" : access.managed ? { role: access.role, roleLabel: access.label, values: access.values, sync: access.sync?.status ?? null } : "access without a managed account") : "no access",
        })),
      };
    },
  },
  {
    name: "get_app_roles",
    admin: true,
    description: "The roles and restrictions an instance's app offers for accounts managed by the Board, and who has access to it.",
    parameters: S({ space: SPACE }, ["space"]),
    readOnly: true,
    run: async (ctx, args) => {
      const s = resolveSpace(ctx.user, args.space);
      const schema = await appSchema(ctx.user, s.id, ctx.lang);
      return {
        space: s.name,
        roles: schema.roles,
        defaultRole: schema.defaultRole,
        restrictions: schema.fields.map((f) => ({ ...fieldBrief(f), ...(f.roles ? { onlyForRoles: f.roles } : {}) })),
        access: instanceAccessList(s.id).map(({ user, access }) => ({ member: user.email, role: access.role ?? null, values: access.values, revoked: access.revoked })),
      };
    },
  },
  {
    name: "set_user_access",
    admin: true,
    description: "Give a member access to an instance, or change their role and restrictions there. The Board creates or updates their account in the app. Without 'role', the member sees the instance but no account is managed. Call get_app_roles first for the roles and restriction names.",
    parameters: S({
      member: { type: "string", description: "Member id or e-mail." },
      space: SPACE,
      role: { type: "string", description: "A role value from get_app_roles (optional)." },
      values: { type: "object", description: "Restrictions to change: { name: value }. The others keep their value.", additionalProperties: true },
    }, ["member", "space"]),
    run: (ctx, args) => {
      const m = resolveMember(args.member);
      const s = resolveSpace(ctx.user, args.space);
      return logged(ctx, "set_user_access", s, { member: m.email, role: args.role ?? null }, async () => {
        const r = await setAccess(ctx.user, s.id, m.id, { role: args.role ?? null, values: args.values }, ctx.lang);
        const sync = r.sync && !r.sync.ok ? ` The app could not be updated yet (${errorMessage(new HttpError(502, r.sync.code, r.sync.message ? { message: r.sync.message } : undefined))}); it will apply at their next sign-in, or retry later.` : "";
        return { ok: true, message: `Access saved for ${m.email} on ${s.name}.${sync}`, access: r.access };
      });
    },
  },
  {
    name: "revoke_user_access",
    admin: true,
    dangerous: true,
    description: "Remove a member's access to an instance: it leaves their Board, they cannot sign in to it through the Board, and their managed account in the app is deactivated (data kept). Needs the person's confirmation.",
    parameters: S({ member: { type: "string" }, space: SPACE }, ["member", "space"]),
    run: async (ctx, args) => {
      const m = resolveMember(args.member);
      const s = resolveSpace(ctx.user, args.space);
      const stop = await gate(ctx, { tool: "revoke_user_access", args: { member: m.id, space: s.id }, title: `Remove ${m.name} (${m.email})'s access`, space: s.name, danger: true, board: true });
      if (stop) return stop;
      return logged(ctx, "revoke_user_access", s, { member: m.email }, async () => {
        const r = await revokeAccess(ctx.user, s.id, m.id, ctx.lang);
        return { ok: true, message: r.removed ? `Access removed for ${m.email}.` : `Access removed from the Board for ${m.email}; the app could not be reached to deactivate the account yet (retry from the Board).` };
      });
    },
  },

  /* ----- Bilans ----- */
  {
    name: "get_report_settings",
    description: "The person's scheduled health report: off, daily or weekly, and when (server time).",
    parameters: S({}),
    readOnly: true,
    run: (ctx) => reportSettings(ctx.user.id),
  },
  {
    name: "set_report_settings",
    description: "Schedule the person's health report of all instances (sent as a Board notification, also on Kosmy Mobile).",
    parameters: S({
      frequency: { type: "string", enum: ["off", "daily", "weekly"] },
      hour: { type: "integer", minimum: 0, maximum: 23, description: "Hour, server time." },
      weekday: { type: "integer", minimum: 0, maximum: 6, description: "For weekly: 0 = Sunday, 1 = Monday…" },
    }, ["frequency"]),
    run: (ctx, args) => logged(ctx, "set_report_settings", null, args, () => ({ ok: true, ...saveReportSettings(ctx.user.id, args) })),
  },
];

/* ---------- Réglage des bilans (aussi utilisé par les routes /api/assistant) ---------- */

export function reportSettings(userId) {
  const r = db.prepare("SELECT * FROM ai_reports WHERE user_id = ?").get(userId);
  return { frequency: r?.frequency ?? "off", hour: r?.hour ?? 8, weekday: r?.weekday ?? 1, lastRunAt: r?.last_run_at ?? null };
}

export function saveReportSettings(userId, body) {
  const cur = reportSettings(userId);
  const frequency = ["off", "daily", "weekly"].includes(body.frequency) ? body.frequency : cur.frequency;
  const int = (v, min, max, d) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : d);
  const hour = int(body.hour, 0, 23, cur.hour);
  const weekday = int(body.weekday, 0, 6, cur.weekday);
  db.prepare(
    `INSERT INTO ai_reports (user_id, frequency, hour, weekday) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET frequency = excluded.frequency, hour = excluded.hour, weekday = excluded.weekday`,
  ).run(userId, frequency, hour, weekday);
  return reportSettings(userId);
}

/* ---------- Choix et exécution ---------- */

/**
 * Les outils d'une porte d'entrée : « chat », « mcp » ou « readonly » (bilans).
 * Les outils réservés aux administrateurs du Board n'apparaissent pas pour les autres.
 */
export function toolsFor(user, mode) {
  return TOOLS.filter((t) => {
    if (t.admin && user.role !== "admin") return false;
    if (mode === "readonly") return t.readOnly;
    if (t.mcpOnly) return mode === "mcp";
    return true;
  });
}

/** Au format « tools » de l'API OpenAI. */
export const openAiTools = (tools) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

/**
 * Exécute un outil. Ne lance jamais : renvoie { ok, result } ou { ok: false, error } (texte pour le modèle).
 * ctx : { user, lang, channel, onDanger(info), reveal(value), approved? }.
 */
export async function runTool(tools, name, args, ctx) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `unknown tool "${name}"` };
  if (tool.admin && ctx.user.role !== "admin") return { ok: false, error: "Board administrators only" };
  try {
    const result = await tool.run(ctx, args && typeof args === "object" && !Array.isArray(args) ? args : {});
    return { ok: true, result };
  } catch (e) {
    if (!e?.toolError && !(e instanceof HttpError)) console.error(`Assistant, outil ${name} :`, e);
    return { ok: false, error: errorMessage(e) };
  }
}

/** L'outil d'origine d'une action en attente, pour l'exécuter après confirmation. */
export const toolByName = (name) => TOOLS.find((t) => t.name === name);

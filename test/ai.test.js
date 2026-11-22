/*
 * Assistant, de bout en bout : un faux fournisseur compatible OpenAI (réponses écrites à l'avance, en flux SSE
 * avec appels d'outils), le Board, et l'appli de démonstration reliée par la connexion unique.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { browser, startServer } from "./helpers.js";

/* ---------- Faux fournisseur ---------- */

const requests = []; // corps reçus
let script = () => ({ content: "?" }); // corps → { content, toolCalls }
const fake = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fake-tools", supported_parameters: ["tools"] }, { id: "fake-plain", supported_parameters: [] }] }));
    return;
  }
  const body = JSON.parse(raw);
  requests.push(body);
  const r = script(body);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (r.content) for (const part of r.content.match(/.{1,8}/gs)) send({ choices: [{ delta: { content: part } }] });
  (r.toolCalls ?? []).forEach((c, index) => {
    const args = JSON.stringify(c.args ?? {});
    // Les arguments arrivent en morceaux, comme chez les vrais fournisseurs.
    send({ choices: [{ delta: { tool_calls: [{ index, id: `call_${requests.length}_${index}`, type: "function", function: { name: c.name, arguments: args.slice(0, 5) } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } }] });
  });
  send({ choices: [{ delta: {}, finish_reason: r.toolCalls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } });
  res.end("data: [DONE]\n\n");
});

/** Les messages d'outils du dernier tour, par nom d'outil appelé. */
const lastToolResults = (body) => body.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content.replace(/… \(truncated\)$/, "")));
const turn = (body) => body.messages.filter((m) => m.role === "assistant").length;

/* ---------- Mise en place ---------- */

let srv, admin, demo, dir, spaceId, adminId;
const DEMO_PORT = 22000 + Math.floor(Math.random() * 2000);
const DEMO = `http://localhost:${DEMO_PORT}`;

async function startDemo(settings) {
  dir = mkdtempSync(path.join(tmpdir(), "kosmy-demo-ai-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(settings));
  const proc = spawn(process.execPath, ["examples/demo-app/server.js"], { env: { ...process.env, PORT: String(DEMO_PORT), DEMO_SETTINGS: file } });
  let out = "";
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      out += d;
      if (out.includes("Appli de démo")) resolve();
    });
    proc.stderr.on("data", (d) => { out += d; });
    proc.on("exit", () => reject(new Error(out)));
  });
  return proc;
}

/** Envoie un message et lit tout le flux : [{ event, data }]. */
async function ask(b, url, body) {
  const r = await b.request("POST", url, body);
  assert.equal(r.status, 200, r.text);
  return r.text.split("\n\n").filter((x) => x.startsWith("event:")).map((block) => {
    const [e, d] = block.split("\n");
    return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
  });
}
const events = (list, name) => list.filter((x) => x.event === name).map((x) => x.data);

before(async () => {
  await new Promise((r) => fake.listen(0, r));
  srv = await startServer({
    AI_PROVIDER: "custom", AI_BASE_URL: `http://localhost:${fake.address().port}/v1`, AI_MODEL: "fake-tools", AI_API_KEY: "sk-test",
    AI_MAX_STEPS: "6",
  });
  admin = browser(srv.base);
  assert.equal((await admin.request("POST", "/api/setup", { code: srv.setupCode, name: "Admin", email: "a@x.fr", password: "motdepasse-123" })).status, 201);
  adminId = (await admin.request("GET", "/api/state")).body.user.id;
  spaceId = (await admin.request("POST", "/api/spaces", { name: "Démo", base: DEMO, path: "/admin" })).body.space.id;
  const on = await admin.request("POST", `/api/spaces/${spaceId}/sso`, { redirectUris: [`${DEMO}/auth/kosmy-board/callback`] });
  demo = await startDemo({
    issuer: `${srv.base}/oidc`, clientId: on.body.clientId, clientSecret: on.body.secret,
    accounts: { [adminId]: { name: "Admin", email: "a@x.fr", role: "admin", linkedAt: Date.now() } },
  });
});

after(async () => {
  if (demo) {
    const exited = new Promise((r) => demo.once("exit", r));
    demo.kill();
    await exited;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  await srv.stop();
  fake.close();
});

/* ---------- Tests ---------- */

test("réglage imposé par l'environnement, liste des modèles avec outils", async () => {
  const s = await admin.request("GET", "/api/assistant/settings");
  assert.equal(s.status, 200);
  assert.equal(s.body.configured, true);
  assert.equal(s.body.hasApiKey, true);
  assert.equal(s.body.env.apiKey, true);
  assert.equal(JSON.stringify(s.body).includes("sk-test"), false, "la clé ne sort jamais");
  const m = await admin.request("POST", "/api/assistant/models", {});
  assert.deepEqual(m.body.models.map((x) => x.id), ["fake-tools"]);
});

test("lecture, puis formulaire envoyé sans action dangereuse ; les autres champs gardent leur valeur", async () => {
  script = (body) => {
    switch (turn(body)) {
      case 0: return { toolCalls: [{ name: "list_spaces" }, { name: "get_admin_section", args: { space: "démo", section: "settings" } }] };
      case 1: return { toolCalls: [{ name: "run_admin_action", args: { space: spaceId, section: "settings", action: "save", values: { signup: true } } }] };
      default: return { content: "Inscriptions ouvertes." };
    }
  };
  const ev = await ask(admin, "/api/assistant/messages", { text: "Ouvre les inscriptions de la démo", lang: "fr" });
  assert.equal(events(ev, "error").length, 0, JSON.stringify(ev));
  const conv = events(ev, "conversation")[0];
  assert.ok(conv.id);
  assert.equal(events(ev, "text").map((x) => x.delta).join(""), "Inscriptions ouvertes.");
  assert.deepEqual(events(ev, "tool_end").map((x) => [x.name, x.ok]), [["list_spaces", true], ["get_admin_section", true], ["run_admin_action", true]]);
  assert.equal(events(ev, "pending").length, 0);
  assert.equal(events(ev, "done").length, 1);

  // Le prompt système nomme l'espace, et les outils de la section sont relus au tour suivant.
  const second = requests.at(-2);
  assert.match(second.messages[0].content, /Démo \(id /);
  assert.equal(lastToolResults(second)[1].section.blocks[0].action, "save");

  const settings = await admin.request("GET", `/api/spaces/${spaceId}/admin/settings`);
  const fields = Object.fromEntries(settings.body.blocks[0].fields.map((f) => [f.name, f.value]));
  assert.equal(fields.signup, true);
  assert.ok(fields.name, "le nom du site est resté");

  const saved = await admin.request("GET", `/api/assistant/conversations/${conv.id}`);
  assert.equal(saved.body.messages[0].text, "Ouvre les inscriptions de la démo");
  assert.equal(saved.body.messages.at(-1).text, "Inscriptions ouvertes.");
  assert.ok(saved.body.usage.input > 0);

  const audit = await admin.request("GET", "/api/assistant/audit");
  assert.equal(audit.body.entries[0].tool, "run_admin_action");
  assert.equal(audit.body.entries[0].ok, true);
  assert.equal(audit.body.entries[0].space, "Démo");
});

test("action dangereuse : en attente, puis exécutée seulement après validation", async () => {
  script = (body) => {
    const last = body.messages.at(-1);
    if (last.role === "user" && last.content.startsWith("[Confirmed]")) return { content: "Sessions fermées." };
    return turn(body) === 0
      ? { toolCalls: [{ name: "run_admin_action", args: { space: "Démo", section: "maintenance", action: "logout-all" } }] }
      : { content: "À confirmer." };
  };
  const before = (await admin.request("GET", "/api/assistant/audit")).body.entries.length;
  const ev = await ask(admin, "/api/assistant/messages", { text: "Ferme toutes les sessions" });
  const [pending] = events(ev, "pending");
  assert.ok(pending, JSON.stringify(ev));
  assert.equal(pending.danger, true);
  assert.equal(pending.space, "Démo");
  assert.match(pending.confirm, /reconnecter/);
  assert.equal(JSON.parse(requests.at(-1).messages.at(-1).content).status, "pending_confirmation");
  assert.equal((await admin.request("GET", "/api/assistant/audit")).body.entries.length, before, "rien d'exécuté");

  const conv = events(ev, "conversation")[0].id;
  assert.equal((await admin.request("GET", `/api/assistant/conversations/${conv}`)).body.pending.length, 1);

  const ok = await ask(admin, `/api/assistant/pending/${pending.id}`, { approve: true });
  assert.equal(events(ok, "decision")[0].status, "done", JSON.stringify(ok));
  assert.equal(events(ok, "text").map((x) => x.delta).join(""), "Sessions fermées.");
  const audit = (await admin.request("GET", "/api/assistant/audit")).body.entries;
  assert.equal(audit[0].tool, "run_admin_action");
  assert.equal(audit[0].detail.action, "logout-all");

  // Une seule fois.
  const again = await ask(admin, `/api/assistant/pending/${pending.id}`, { approve: true });
  assert.equal(events(again, "error")[0].error, "ai_pending_done");
  assert.equal((await admin.request("GET", `/api/assistant/conversations/${conv}`)).body.pending.length, 0);
});

test("valeur à montrer une fois : à la personne, jamais au fournisseur ; action inventée refusée", async () => {
  script = (body) => {
    switch (turn(body)) {
      case 0: return { toolCalls: [
        { name: "run_admin_action", args: { space: "Démo", section: "users", action: "invite", values: { email: "z@x.fr" } } },
        { name: "run_admin_action", args: { space: "Démo", section: "users", action: "drop-database" } },
      ] };
      default: return { content: "Invitation créée." };
    }
  };
  const ev = await ask(admin, "/api/assistant/messages", { text: "Invite z@x.fr" });
  const [reveal] = events(ev, "reveal");
  assert.ok(reveal?.value.startsWith(`${DEMO}/login?invitation=`), JSON.stringify(ev));
  assert.equal(JSON.stringify(requests.at(-1)).includes("invitation="), false, "le lien ne part pas chez le fournisseur");
  const [invite, invented] = lastToolResults(requests.at(-1));
  assert.match(invite.reveal, /shown to the person/);
  assert.match(invented.error, /no action "drop-database"/);
});

test("limite d'étapes, réglage des bilans, droits des membres", async () => {
  script = () => ({ toolCalls: [{ name: "list_spaces" }] });
  const ev = await ask(admin, "/api/assistant/messages", { text: "boucle" });
  assert.match(events(ev, "text").map((x) => x.delta).join(""), /trop d'étapes/);

  const r = await admin.request("PUT", "/api/assistant/report", { frequency: "weekly", hour: 7, weekday: 1 });
  assert.deepEqual([r.body.frequency, r.body.hour, r.body.weekday], ["weekly", 7, 1]);

  // Un membre n'a ni le réglage du fournisseur, ni les outils des membres du Board.
  const inv = await admin.request("POST", "/api/invites", { role: "member" });
  const member = browser(srv.base);
  await member.request("POST", "/api/invites/accept", { token: inv.body.url.split("/").pop(), name: "M", email: "m@x.fr", password: "motdepasse-456" });
  assert.equal((await member.request("GET", "/api/assistant/settings")).status, 403);
  script = (body) => (turn(body) === 0 ? { toolCalls: [{ name: "list_members" }] } : { content: "Non." });
  await ask(member, "/api/assistant/messages", { text: "Qui est membre ?" });
  const sent = requests.at(-2);
  assert.equal(sent.tools.some((t) => t.function.name === "list_members"), false);
  assert.match(lastToolResults(requests.at(-1))[0].error, /unknown tool/);
  // Et il ne voit pas les conversations des autres.
  const mine = (await admin.request("GET", "/api/assistant")).body.conversations[0].id;
  assert.equal((await member.request("GET", `/api/assistant/conversations/${mine}`)).status, 404);
});

test("bilan : lecture seule, gardé comme conversation, envoyé en notification", async () => {
  script = (body) => (turn(body) === 0 ? { toolCalls: [{ name: "fleet_overview" }] } : { content: "**Tout va bien.**\n- Démo : aucune alerte" });
  const r = await admin.request("POST", "/api/assistant/report/run", {});
  assert.equal(r.status, 202, r.text);
  let notif;
  for (let i = 0; i < 50 && !notif; i++) {
    await new Promise((ok) => setTimeout(ok, 100));
    notif = (await admin.request("GET", "/api/notifications")).body.notifications.find((n) => n.app.name === "Kosmy Board");
  }
  assert.ok(notif, "notification reçue");
  assert.equal(notif.title, "Bilan de vos instances");
  assert.match(notif.body, /^Tout va bien\.\n• Démo : aucune alerte$/);
  const convId = notif.url.split("/").pop();
  assert.ok(notif.url.startsWith(`${srv.base}/#/assistant/`));
  const conv = (await admin.request("GET", `/api/assistant/conversations/${convId}`)).body;
  assert.equal(conv.source, "report");
  assert.equal(conv.messages[0].kind, "report");
  // Seulement des outils de lecture.
  const offered = requests.at(-2).tools.map((t) => t.function.name);
  assert.ok(offered.includes("fleet_overview"));
  for (const name of ["run_admin_action", "delete_space", "add_space", "invite_member", "set_report_settings"]) assert.equal(offered.includes(name), false, name);
  assert.ok((await admin.request("GET", "/api/assistant")).body.report.lastRunAt);
});

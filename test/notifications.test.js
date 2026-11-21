/* Notifications : une appli reliée envoie, les personnes concernées lisent (Board et Kosmy Mobile). */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { browser, startServer } from "./helpers.js";

let srv, admin, member, adminId, memberId, client, deviceToken;
const APP = "http://localhost:9933";

const basic = (id, secret) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
const notify = (body, auth = basic(client.id, client.secret)) =>
  fetch(`${srv.base}/api/apps/notifications`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  srv = await startServer();
  admin = browser(srv.base);
  member = browser(srv.base);
  await admin.request("POST", "/api/setup", { code: srv.setupCode, name: "Admin", email: "a@x.fr", password: "motdepasse-123" });
  adminId = (await admin.request("GET", "/api/state")).body.user.id;
  const inv = await admin.request("POST", "/api/invites", { role: "member" });
  await member.request("POST", "/api/invites/accept", { token: inv.body.url.split("/").pop(), name: "M", email: "m@x.fr", password: "motdepasse-456" });
  memberId = (await member.request("GET", "/api/state")).body.user.id;
  // L'admin et le membre ont tous les deux l'instance reliée dans leur Board.
  const sp = await admin.request("POST", "/api/spaces", { appId: "soundy", name: "Soundy", base: APP, path: "/" });
  const on = await admin.request("POST", `/api/spaces/${sp.body.space.id}/sso`, { redirectUris: [`${APP}/auth/kosmy-board/callback`] });
  client = { id: on.body.clientId, secret: on.body.secret };
  const sp2 = await member.request("POST", "/api/spaces", { appId: "soundy", name: "Musique", base: APP, path: "/" });
  await member.request("POST", `/api/spaces/${sp2.body.space.id}/sso`, {});
  const dev = await fetch(`${srv.base}/api/device/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@x.fr", password: "motdepasse-123", device: "Kosmy Mobile · Test" }),
  }).then((r) => r.json());
  deviceToken = dev.token;
});
after(() => srv.stop());

test("la découverte indique où envoyer les notifications", async () => {
  const d = await fetch(`${srv.base}/oidc/.well-known/openid-configuration`).then((r) => r.json());
  assert.equal(d.kosmy_notifications_endpoint, `${srv.base}/api/apps/notifications`);
  assert.deepEqual(d.claim_types_supported, ["normal"]);
});

test("mauvais secret ou pas d'authentification : refusé", async () => {
  assert.equal((await notify({ title: "x" }, basic(client.id, "mauvais"))).status, 401);
  assert.equal((await notify({ title: "x" }, "")).status, 401);
  assert.equal((await notify({ title: "x" }, basic("kb-inconnu", client.secret))).status, 401);
});

test("validation : titre obligatoire, lien sur l'instance seulement", async () => {
  assert.equal((await notify({})).body.error, "title");
  assert.equal((await notify({ title: "x", url: "https://ailleurs.example.com/" })).body.error, "url");
  assert.equal((await notify({ title: "x", to: "pas-une-liste" })).body.error, "to");
});

test("« to » limite aux comptes choisis", async () => {
  const r = await notify({ title: "🎵 Nouvelle demande Soundy", body: "Léa demande « Abbey Road »", url: "/#/requests", to: [adminId, "inconnu"] });
  assert.equal(r.status, 200);
  assert.equal(r.body.delivered, 1);
  const a = (await admin.request("GET", "/api/notifications")).body;
  assert.equal(a.unread, 1);
  assert.equal(a.notifications[0].title, "🎵 Nouvelle demande Soundy");
  assert.equal(a.notifications[0].url, `${APP}/#/requests`);
  assert.equal(a.notifications[0].app.name, "Soundy");
  assert.equal(a.notifications[0].app.appId, "soundy");
  assert.ok(a.notifications[0].app.spaceId);
  assert.equal((await member.request("GET", "/api/notifications")).body.notifications.length, 0);
});

test("sans « to » : toutes les personnes qui ont l'instance reliée", async () => {
  assert.equal((await notify({ title: "Pour tous" })).body.delivered, 2);
  const m = (await member.request("GET", "/api/notifications")).body;
  assert.equal(m.notifications[0].title, "Pour tous");
  assert.equal(m.notifications[0].app.name, "Soundy"); // le nom du client, pas celui donné par le membre
});

test("Kosmy Mobile lit les nouvelles par jeton d'appareil, avec « after »", async () => {
  const get = (q = "") => fetch(`${srv.base}/api/notifications${q}`, { headers: { Authorization: `Bearer ${deviceToken}` } }).then((r) => r.json());
  const all = await get();
  assert.equal(all.notifications.length, 2);
  const last = all.notifications[0].id;
  assert.equal((await get(`?after=${last}`)).notifications.length, 0);
  await notify({ title: "Encore une", to: [adminId] });
  const fresh = await get(`?after=${last}`);
  assert.deepEqual(fresh.notifications.map((n) => n.title), ["Encore une"]);
  // Marquer lu depuis le téléphone (pas de vérification d'origine avec un jeton)
  const r = await fetch(`${srv.base}/api/notifications/read`, {
    method: "POST", headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [fresh.notifications[0].id] }),
  }).then((x) => x.json());
  assert.equal(r.unread, 2);
});

test("marquer tout lu, supprimer", async () => {
  const r = await admin.request("POST", "/api/notifications/read", {});
  assert.equal(r.body.unread, 0);
  const list = (await admin.request("GET", "/api/notifications")).body.notifications;
  assert.ok(list.every((n) => n.read));
  assert.equal((await admin.request("DELETE", `/api/notifications/${list[0].id}`)).status, 200);
  assert.equal((await admin.request("DELETE", `/api/notifications/${list[0].id}`)).status, 404);
  // On ne supprime pas celles des autres
  const mine = (await member.request("GET", "/api/notifications")).body.notifications;
  assert.equal((await admin.request("DELETE", `/api/notifications/${mine[0].id}`)).status, 404);
  await admin.request("DELETE", "/api/notifications");
  assert.equal((await admin.request("GET", "/api/notifications")).body.notifications.length, 0);
});

test("trop d'envois en une minute : 429", async () => {
  let last;
  for (let i = 0; i < 30; i++) last = await notify({ title: `n${i}`, to: [] });
  assert.equal(last.status, 429);
  assert.equal(last.body.error, "rate_limited");
});

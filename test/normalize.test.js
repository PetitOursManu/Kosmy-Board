import assert from "node:assert/strict";
import { test } from "node:test";

import { hostOf, isLocalHost, normalizeBase, normalizePath, spaceUrl } from "../public/js/normalize.js";

test("normalizeBase ajoute https:// et nettoie l'adresse", () => {
  assert.deepEqual(normalizeBase("Kanby.MonDomaine.fr/"), { base: "https://kanby.mondomaine.fr" });
  assert.deepEqual(normalizeBase("  http://192.168.1.20:3000  "), { base: "http://192.168.1.20:3000" });
  assert.deepEqual(normalizeBase("https://x.fr/sous/dossier/?a=1#b"), { base: "https://x.fr/sous/dossier" });
});

test("normalizeBase retire la page d'admin collée avec l'adresse", () => {
  assert.deepEqual(normalizeBase("kanby.fr/admin/", "/admin"), { base: "https://kanby.fr" });
  assert.deepEqual(normalizeBase("lumy.fr/docs/_lumy/admin", "/_lumy/admin"), { base: "https://lumy.fr/docs" });
  assert.deepEqual(normalizeBase("dashy.fr/admin", "/"), { base: "https://dashy.fr/admin" });
});

test("normalizeBase refuse les adresses inutilisables", () => {
  assert.deepEqual(normalizeBase(""), { error: "empty" });
  assert.deepEqual(normalizeBase("ftp://x.fr"), { error: "scheme" });
  assert.deepEqual(normalizeBase("user:pw@x.fr"), { error: "credentials" });
  assert.deepEqual(normalizeBase("javascript:alert(1)"), { error: "invalid" });
  assert.deepEqual(normalizeBase("x..fr"), { error: "invalid" });
  assert.deepEqual(normalizeBase("<script>.fr"), { error: "invalid" });
});

test("normalizePath", () => {
  assert.equal(normalizePath(""), "/");
  assert.equal(normalizePath("admin"), "/admin");
  assert.equal(normalizePath("/admin.html"), "/admin.html");
  assert.equal(normalizePath("//evil.com"), null);
  assert.equal(normalizePath("/a b"), null);
  assert.equal(normalizePath('/"onload'), null);
});

test("adresses et réseau local", () => {
  assert.equal(spaceUrl({ base: "https://k.fr", path: "admin" }), "https://k.fr/admin");
  assert.equal(hostOf("https://k.fr:8443/x"), "k.fr:8443");
  for (const h of ["localhost", "nas", "192.168.1.2:80", "10.0.0.1", "172.20.1.1", "srv.lan", "pi.local", "[::1]", "[fd12::1]"]) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ["kanby.fr", "8.8.8.8", "172.32.0.1", "example.com:8080"]) assert.equal(isLocalHost(h), false, h);
});

/* Interface : scripts et styles versionnés, pour qu'un déploiement soit vu tout de suite malgré les caches. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers.js";

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

test("index.html charge l'interface sous un préfixe de version, sans cache", async () => {
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  const html = await res.text();
  const v = html.match(/src="v\/([0-9a-f]{12})\/js\/app\.js"/)?.[1];
  assert.ok(v, "app.js versionné");
  assert.match(html, new RegExp(`href="v/${v}/styles\.css"`));

  const js = await fetch(`${srv.base}/v/${v}/js/views/list.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("cache-control"), /immutable/);
  assert.match(await js.text(), /data-admin/);

  const old = await fetch(`${srv.base}/v/000000000000/js/app.js`);
  assert.equal(old.status, 200);
  assert.equal(old.headers.get("cache-control"), "no-cache");
});

test("le préfixe de version ne permet pas de sortir du dossier public", async () => {
  const res = await fetch(`${srv.base}/v/x/..%2f..%2fpackage.json`);
  assert.notEqual(res.status, 200);
});

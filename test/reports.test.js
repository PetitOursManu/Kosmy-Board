/* Bilans planifiés : le dernier créneau prévu. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "kosmy-board-reports-"));
const { lastSlot } = await import("../server/ai/reports.js");

const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min);

test("chaque jour", () => {
  const r = { frequency: "daily", hour: 8, weekday: 1 };
  assert.equal(lastSlot(r, at(2026, 11, 22, 9, 30)), at(2026, 11, 22, 8).getTime());
  assert.equal(lastSlot(r, at(2026, 11, 22, 7, 59)), at(2026, 11, 21, 8).getTime());
  assert.equal(lastSlot(r, at(2026, 11, 22, 8, 0)), at(2026, 11, 22, 8).getTime());
});

test("chaque semaine, et désactivé", () => {
  const monday = { frequency: "weekly", hour: 8, weekday: 1 };
  // Dimanche 22 novembre 2026 : le dernier lundi est le 16.
  assert.equal(lastSlot(monday, at(2026, 11, 22, 12)), at(2026, 11, 16, 8).getTime());
  assert.equal(lastSlot(monday, at(2026, 11, 23, 8, 5)), at(2026, 11, 23, 8).getTime());
  assert.equal(lastSlot(monday, at(2026, 11, 23, 7)), at(2026, 11, 16, 8).getTime());
  assert.equal(lastSlot({ frequency: "off", hour: 8, weekday: 1 }, new Date()), null);
});

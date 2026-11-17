import assert from "node:assert/strict";
import { test } from "node:test";

import { base32Decode, base32Encode, newRecoveryCodes, normalizeRecovery, totpAt, verifyTotp } from "../server/totp.js";

test("TOTP : valeurs de référence de la RFC 6238 (SHA-1)", () => {
  const key = Buffer.from("12345678901234567890");
  const cases = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  for (const [time, expected] of cases) assert.equal(totpAt(key, Math.floor(time / 30), { digits: 8 }), expected, String(time));
});

test("base32 aller-retour", () => {
  const buf = Buffer.from("Kosmy Board ✓");
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
});

test("vérification avec tolérance et sans rejeu", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  assert.equal(verifyTotp(secret, totpAt(secret, step), null, now), step);
  assert.equal(verifyTotp(secret, totpAt(secret, step - 1), null, now), step - 1);
  assert.equal(verifyTotp(secret, totpAt(secret, step - 2), null, now), null);
  assert.equal(verifyTotp(secret, totpAt(secret, step), step, now), null);
  assert.equal(verifyTotp(secret, "12a456", null, now), null);
});

test("codes de secours", () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.equal(normalizeRecovery(" abcd-ef23 "), "ABCDEF23");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress } from "../server/config.js";

test("une adresse sans protocole passe en https (http en local)", () => {
  assert.deepEqual(parseAddress("board.mondomaine.fr", "PUBLIC_URL"), { url: "https://board.mondomaine.fr", added: true });
  assert.deepEqual(parseAddress(" board.mondomaine.fr/ ", "PUBLIC_URL"), { url: "https://board.mondomaine.fr", added: true });
  assert.deepEqual(parseAddress("localhost:8767", "PUBLIC_URL"), { url: "http://localhost:8767", added: true });
  assert.deepEqual(parseAddress("127.0.0.1:8767", "PUBLIC_URL"), { url: "http://127.0.0.1:8767", added: true });
});

test("une adresse complète est gardée, sans « / » final", () => {
  assert.deepEqual(parseAddress("https://board.mondomaine.fr/", "PUBLIC_URL"), { url: "https://board.mondomaine.fr", added: false });
  assert.deepEqual(parseAddress("http://192.168.1.10:8767", "PUBLIC_URL"), { url: "http://192.168.1.10:8767", added: false });
  assert.deepEqual(parseAddress("HTTPS://Board.MonDomaine.fr", "PUBLIC_URL"), { url: "https://board.mondomaine.fr", added: false });
});

test("une adresse invalide donne un message clair", () => {
  assert.throws(() => parseAddress("https://", "PUBLIC_URL"), /PUBLIC_URL n'est pas une adresse valable/);
  assert.throws(() => parseAddress("ftp://board.mondomaine.fr", "PUBLIC_URL"), /doit commencer par https:\/\//);
  assert.throws(() => parseAddress("https://board.mondomaine.fr/?x=1", "PUBLIC_URL"), /sans « \? »/);
  assert.throws(() => parseAddress("https://moi:secret@board.mondomaine.fr", "PUBLIC_URL"), /identifiants/);
});

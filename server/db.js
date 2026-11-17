/* Base de données SQLite (module intégré à Node 24 : aucune dépendance native). */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { config } from "./config.js";

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, "board.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");

/** Chaque entrée fait passer la base à la version suivante. Ne jamais modifier une entrée publiée : en ajouter une. */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    lang TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE spaces (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    app_id TEXT,
    name TEXT NOT NULL,
    base TEXT NOT NULL,
    path TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    opened_at INTEGER,
    PRIMARY KEY (user_id, id)
  );
  `,
];

const { user_version: version } = db.prepare("PRAGMA user_version").get();
for (let v = version; v < MIGRATIONS.length; v++) {
  db.exec("BEGIN");
  try {
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Exécute fn dans une transaction. */
export function tx(fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

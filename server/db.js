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
  /* v2 : connexion unique (OpenID Connect) et double authentification. */
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE oidc_store (
    model TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    grant_id TEXT,
    user_code TEXT,
    uid TEXT,
    expires_at INTEGER,
    consumed_at INTEGER,
    PRIMARY KEY (model, id)
  );
  CREATE INDEX oidc_store_grant ON oidc_store(grant_id);
  CREATE INDEX oidc_store_uid ON oidc_store(model, uid);
  CREATE INDEX oidc_store_expires ON oidc_store(expires_at);
  CREATE TABLE sso_clients (
    client_id TEXT PRIMARY KEY,
    base TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    app_id TEXT,
    secret TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    initiate_login_uri TEXT,
    auth_method TEXT NOT NULL DEFAULT 'client_secret_basic',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    secret_at INTEGER NOT NULL
  );
  ALTER TABLE spaces ADD COLUMN client_id TEXT REFERENCES sso_clients(client_id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_pending TEXT;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT;
  `,
  /* v3 : appareils (Kosmy Mobile). Une session avec un nom d'appareil s'utilise par jeton (Authorization: Bearer), pas par cookie. */
  `
  ALTER TABLE sessions ADD COLUMN device TEXT;
  `,
  /* v4 : notifications envoyées par les applis reliées (docs/notifications.md), lues dans le Board et Kosmy Mobile. */
  `
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT REFERENCES sso_clients(client_id) ON DELETE SET NULL,
    app_name TEXT NOT NULL,
    app_id TEXT,
    title TEXT NOT NULL,
    body TEXT,
    url TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX notifications_user ON notifications(user_id, id);
  `,
  /* v5 : l'Assistant (docs/assistant.md) — conversations, actions en attente de confirmation, journal, bilans, accès MCP. */
  `
  CREATE TABLE ai_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'report')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX ai_conversations_user ON ai_conversations(user_id, updated_at);
  CREATE TABLE ai_messages (
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    usage TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  );
  CREATE TABLE ai_pending (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES ai_conversations(id) ON DELETE CASCADE,
    call_id TEXT,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'refused', 'failed', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX ai_pending_conversation ON ai_pending(conversation_id);
  CREATE TABLE ai_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    tool TEXT NOT NULL,
    space_id TEXT,
    space_name TEXT,
    detail TEXT,
    ok INTEGER NOT NULL,
    message TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ai_audit_user ON ai_audit(user_id, id);
  CREATE TABLE ai_reports (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    frequency TEXT NOT NULL DEFAULT 'off' CHECK (frequency IN ('off', 'daily', 'weekly')),
    hour INTEGER NOT NULL DEFAULT 8,
    weekday INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER
  );
  CREATE TABLE mcp_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER
  );
  CREATE INDEX mcp_tokens_user ON mcp_tokens(user_id);
  `,
  /*
   * v6 : les instances deviennent communes au Board (docs/users-api.md). Un administrateur du Board les ajoute
   * et choisit qui y a accès, avec un rôle et des restrictions propres à chaque appli. Les espaces personnels
   * d'avant deviennent des instances (une par adresse) et des accès « non gérés » (sans rôle).
   */
  (db) => {
    db.exec(`
      CREATE TABLE instances (
        id TEXT PRIMARY KEY,
        app_id TEXT,
        name TEXT NOT NULL,
        base TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        client_id TEXT UNIQUE REFERENCES sso_clients(client_id) ON DELETE SET NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE access (
        instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT,
        role_label TEXT,
        role_admin INTEGER NOT NULL DEFAULT 0,
        settings TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        granted_at INTEGER NOT NULL,
        sync_status TEXT,
        sync_message TEXT,
        synced_at INTEGER,
        PRIMARY KEY (instance_id, user_id)
      );
      CREATE INDEX access_user ON access(user_id);
      CREATE TABLE opened (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        PRIMARY KEY (user_id, instance_id)
      );
      CREATE TABLE password_links (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX password_links_user ON password_links(user_id);
    `);
    // Les espaces des administrateurs d'abord : leur nom et leur page d'admin donnent ceux de l'instance.
    const rows = db.prepare(
      "SELECT s.*, u.role AS user_role FROM spaces s JOIN users u ON u.id = s.user_id ORDER BY (u.role = 'admin') DESC, s.added_at",
    ).all();
    const byBase = new Map();
    const ids = new Set();
    const clientOf = db.prepare("SELECT client_id FROM sso_clients WHERE base = ?");
    const insertInstance = db.prepare(
      "INSERT INTO instances (id, app_id, name, base, path, client_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertAccess = db.prepare("INSERT OR IGNORE INTO access (instance_id, user_id, granted_at) VALUES (?, ?, ?)");
    const insertOpened = db.prepare(
      "INSERT INTO opened (user_id, instance_id, at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET at = MAX(at, excluded.at)",
    );
    for (const r of rows) {
      let id = byBase.get(r.base);
      if (!id) {
        id = r.id;
        while (ids.has(id)) id = `${r.id}-${ids.size}`;
        ids.add(id);
        byBase.set(r.base, id);
        insertInstance.run(id, r.app_id, r.name, r.base, r.path, clientOf.get(r.base)?.client_id ?? null, r.user_id, r.added_at);
      }
      insertAccess.run(id, r.user_id, r.added_at);
      if (r.opened_at) insertOpened.run(r.user_id, id, r.opened_at);
    }
    // Un client sans instance (ne devrait pas exister) : plus rien ne s'y rattache.
    db.exec("DELETE FROM sso_clients WHERE client_id NOT IN (SELECT client_id FROM instances WHERE client_id IS NOT NULL)");
    db.exec("DROP TABLE spaces");
  },
];

/** Petites valeurs persistantes (clés de signature, secrets des cookies). */
export const meta = {
  get: (key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null,
  set: (key, value) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value),
};

const { user_version: version } = db.prepare("PRAGMA user_version").get();
for (let v = version; v < MIGRATIONS.length; v++) {
  db.exec("BEGIN");
  try {
    const m = MIGRATIONS[v];
    if (typeof m === "function") m(db);
    else db.exec(m);
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

export const SCHEMA_VERSION = 2;

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_identity (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  identity TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  repository_identity TEXT NOT NULL REFERENCES repositories(identity),
  branch TEXT NOT NULL,
  task_label TEXT,
  pid INTEGER,
  state TEXT NOT NULL CHECK (state IN ('active', 'idle', 'ended', 'stale')),
  started_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS sessions_presence_idx
  ON sessions(repository_identity, branch, state, last_active_at DESC);
CREATE INDEX IF NOT EXISTS sessions_address_idx
  ON sessions(address, state, last_active_at DESC);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  sender_session_id TEXT REFERENCES sessions(id),
  sender_address TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL REFERENCES sessions(id),
  recipient_address TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'surfaced', 'read')),
  created_at INTEGER NOT NULL,
  surfaced_at INTEGER,
  read_at INTEGER
);

CREATE INDEX IF NOT EXISTS messages_inbox_idx
  ON messages(recipient_session_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS message_receipts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL CHECK (type IN ('surfaced', 'read')),
  created_at INTEGER NOT NULL,
  UNIQUE(message_id, session_id, type)
);

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL REFERENCES sessions(id),
  owner_address TEXT NOT NULL,
  repository_identity TEXT NOT NULL REFERENCES repositories(identity),
  branch TEXT NOT NULL,
  paths_json TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE INDEX IF NOT EXISTS leases_active_idx
  ON leases(repository_identity, expires_at, released_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface SchemaMigration {
  version: number;
  sql: string;
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  { version: 1, sql: INITIAL_SCHEMA_SQL },
  {
    version: 2,
    sql: `
      ALTER TABLE messages ADD COLUMN idempotency_key TEXT;
      CREATE UNIQUE INDEX messages_idempotency_idx ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `,
  },
];

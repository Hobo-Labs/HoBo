/** Current SQLite schema version stored in PRAGMA user_version. */
export const SCHEMA_VERSION = 2;

/** Schema version of the pre-migration runtime-local events/snapshots layout. */
export const LEGACY_SCHEMA_VERSION = 1;

/**
 * Native connection pragmas. Browser adapters must NOT copy WAL blindly —
 * use the OPFS VFS journal/locking mode documented for that VFS.
 */
export const NATIVE_PRAGMAS = Object.freeze({
	journal_mode: "WAL",
	synchronous: "FULL",
	foreign_keys: "ON",
	busy_timeout: 5000,
	// defensive / security
	// recursive_triggers off by default
});

/**
 * Schema v2 — stream heads, positioned events, durable journal tables.
 * STRICT tables when the runtime supports them; applied after version check.
 */
export const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS streams (
  stream_id        TEXT PRIMARY KEY,
  revision         INTEGER NOT NULL CHECK (revision >= 0),
  owner_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  global_position  INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id        TEXT NOT NULL,
  seq              INTEGER NOT NULL CHECK (seq > 0),
  id               TEXT NOT NULL UNIQUE,
  type             TEXT NOT NULL,
  v                INTEGER NOT NULL CHECK (v > 0),
  ts               TEXT NOT NULL,
  actor            BLOB NOT NULL,
  tenant           TEXT NOT NULL,
  project          TEXT,
  causation_id     TEXT,
  correlation_id   TEXT,
  lane             TEXT,
  payload_codec    TEXT NOT NULL,
  data             BLOB NOT NULL,
  metadata_codec   TEXT NOT NULL,
  meta             BLOB NOT NULL,
  idempotency_key  TEXT,
  FOREIGN KEY (stream_id) REFERENCES streams(stream_id),
  UNIQUE (stream_id, seq),
  UNIQUE (stream_id, idempotency_key)
) STRICT;

CREATE INDEX IF NOT EXISTS events_stream_seq
  ON events(stream_id, seq);

CREATE INDEX IF NOT EXISTS events_type_position
  ON events(type, global_position);

CREATE INDEX IF NOT EXISTS events_tenant_position
  ON events(tenant, global_position);

CREATE INDEX IF NOT EXISTS events_lane_position
  ON events(lane, global_position)
  WHERE lane IS NOT NULL;

CREATE TABLE IF NOT EXISTS snapshots (
  stream_id         TEXT NOT NULL,
  seq               INTEGER NOT NULL CHECK (seq >= 0),
  state_codec       TEXT NOT NULL,
  state             BLOB NOT NULL,
  saved_at          TEXT NOT NULL,
  PRIMARY KEY (stream_id, seq),
  FOREIGN KEY (stream_id) REFERENCES streams(stream_id)
) STRICT;

CREATE INDEX IF NOT EXISTS snapshots_stream_latest
  ON snapshots(stream_id, seq DESC);

CREATE TABLE IF NOT EXISTS subscription_leases (
  subscription_id   TEXT NOT NULL,
  partition_id      TEXT NOT NULL,
  holder_id         TEXT NOT NULL,
  fence_token       INTEGER NOT NULL CHECK (fence_token > 0),
  expires_at        TEXT NOT NULL,
  PRIMARY KEY (subscription_id, partition_id)
) STRICT;

CREATE TABLE IF NOT EXISTS subscription_checkpoints (
  subscription_id   TEXT NOT NULL,
  partition_id      TEXT NOT NULL,
  position          INTEGER NOT NULL CHECK (position >= 0),
  fence_token       INTEGER NOT NULL CHECK (fence_token > 0),
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (subscription_id, partition_id)
) STRICT;

CREATE TABLE IF NOT EXISTS queue_messages (
  message_id         TEXT PRIMARY KEY,
  queue_name         TEXT NOT NULL,
  actor_key          TEXT,
  idempotency_key    TEXT NOT NULL,
  body_codec         TEXT NOT NULL,
  body               BLOB NOT NULL,
  state              TEXT NOT NULL,
  available_at       TEXT NOT NULL,
  delivery_attempt   INTEGER NOT NULL DEFAULT 0,
  lease_id           TEXT,
  lease_fence        INTEGER,
  lease_expires_at   TEXT,
  completed_at       TEXT,
  created_position   INTEGER,
  UNIQUE (queue_name, idempotency_key)
) STRICT;

CREATE INDEX IF NOT EXISTS queue_messages_available
  ON queue_messages(queue_name, state, available_at);

CREATE TABLE IF NOT EXISTS durable_timers (
  timer_id            TEXT PRIMARY KEY,
  timer_kind          TEXT NOT NULL,
  subject_id          TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  due_at              TEXT NOT NULL,
  occurrence          INTEGER NOT NULL DEFAULT 0,
  payload_codec       TEXT NOT NULL,
  payload             BLOB NOT NULL,
  fired_at            TEXT,
  created_position    INTEGER,
  UNIQUE (subject_id, idempotency_key)
) STRICT;

CREATE INDEX IF NOT EXISTS durable_timers_due
  ON durable_timers(fired_at, due_at);

CREATE TABLE IF NOT EXISTS cron_schedules (
  schedule_id         TEXT PRIMARY KEY,
  every_ms            INTEGER NOT NULL CHECK (every_ms > 0),
  start_at            TEXT NOT NULL,
  next_fire_at        TEXT NOT NULL,
  occurrence          INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id            TEXT PRIMARY KEY,
  destination          TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  payload_codec        TEXT NOT NULL,
  payload              BLOB NOT NULL,
  headers_codec        TEXT NOT NULL,
  headers              BLOB NOT NULL,
  state                TEXT NOT NULL,
  available_at         TEXT NOT NULL,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  lease_id             TEXT,
  lease_fence          INTEGER,
  lease_expires_at     TEXT,
  acknowledged_at      TEXT,
  last_error           TEXT,
  created_position     INTEGER,
  UNIQUE (destination, idempotency_key)
) STRICT;

CREATE INDEX IF NOT EXISTS outbox_available
  ON outbox(state, available_at);

CREATE TABLE IF NOT EXISTS actor_leases (
  lease_key            TEXT PRIMARY KEY,
  holder_id            TEXT NOT NULL,
  fence_token          INTEGER NOT NULL CHECK (fence_token > 0),
  expires_at           TEXT NOT NULL,
  released             INTEGER NOT NULL DEFAULT 0
) STRICT;
`;

/**
 * Legacy v1 schema as created by runtime-local before this package.
 * Used only to build migration fixtures and detect v1 databases.
 */
export const LEGACY_V1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  v INTEGER NOT NULL DEFAULT 1,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  tenant TEXT NOT NULL,
  project TEXT,
  causation_id TEXT,
  correlation_id TEXT,
  lane TEXT,
  data TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  PRIMARY KEY (stream_id, seq),
  UNIQUE (stream_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS snapshots (
  stream_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
`;

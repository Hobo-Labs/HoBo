import type { Pool } from "pg";

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hobo_event_streams (
  stream_id TEXT PRIMARY KEY,
  current_seq BIGINT NOT NULL DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS hobo_events (
  stream_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  envelope JSONB NOT NULL,
  idempotency_key TEXT,
  PRIMARY KEY (stream_id, seq)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS hobo_events_stream_idempotency_idx
  ON hobo_events (stream_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS hobo_queue_messages (
  message_id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body JSONB NOT NULL,
  state TEXT NOT NULL,
  available_at_ms BIGINT NOT NULL,
  delivery_attempt INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at_ms BIGINT,
  completed_at_ms BIGINT,
  processing BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (queue_name, idempotency_key)
)`,
  `CREATE TABLE IF NOT EXISTS hobo_actor_leases (
  actor_key TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  fence_token BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  released BOOLEAN NOT NULL DEFAULT FALSE
)`,
  `CREATE TABLE IF NOT EXISTS hobo_actor_events (
  actor_key TEXT NOT NULL,
  seq BIGINT NOT NULL,
  fence_token BIGINT,
  event JSONB NOT NULL,
  PRIMARY KEY (actor_key, seq)
)`,
  `CREATE TABLE IF NOT EXISTS hobo_runtime_clock (
  clock_id TEXT PRIMARY KEY,
  now_ms BIGINT NOT NULL,
  seed TEXT,
  trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_message_seq BIGINT NOT NULL DEFAULT 1,
  next_lease_seq BIGINT NOT NULL DEFAULT 1,
  next_timer_seq BIGINT NOT NULL DEFAULT 1
)`,
  `CREATE TABLE IF NOT EXISTS hobo_timers (
  timer_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  run_id TEXT NOT NULL,
  label TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  scheduled_at_ms BIGINT NOT NULL,
  fire_at_ms BIGINT NOT NULL,
  fired_at_ms BIGINT,
  fired_order BIGINT
)`,
  `CREATE TABLE IF NOT EXISTS hobo_cron_schedules (
  schedule_id TEXT PRIMARY KEY,
  every_ms BIGINT NOT NULL,
  start_at_ms BIGINT NOT NULL,
  next_fire_at_ms BIGINT NOT NULL,
  occurrence BIGINT NOT NULL DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS hobo_stream_runs (
  run_id TEXT PRIMARY KEY,
  buffer_limit INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT
)`,
  `CREATE TABLE IF NOT EXISTS hobo_stream_chunks (
  run_id TEXT NOT NULL,
  stream_name TEXT NOT NULL,
  chunk_seq BIGINT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (run_id, stream_name, chunk_seq)
)`,
  `CREATE TABLE IF NOT EXISTS hobo_runtime_sequences (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 1
)`,
];

export async function migrateSchema(pool: Pool): Promise<void> {
  for (const statement of DDL_STATEMENTS) {
    await pool.query(statement);
  }
}

export function migrateSchemaStatements(): readonly string[] {
  return DDL_STATEMENTS;
}

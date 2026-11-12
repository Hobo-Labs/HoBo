/**
 * 0001 — initial journal schema.
 *
 * Applied migrations are immutable: their checksum is recorded and verified
 * on every start. A schema change is a new numbered file.
 *
 * Timestamps are ISO-8601 text written from the store's injected clock, so a
 * replay with the same clock produces the same rows (I8); they are never
 * read from the server clock.
 */
export const name = "initial";

export function sql(s: string): string {
	return `
-- One row: the schema is the partition. Every append takes this row lock
-- just before inserting, so positions are allocated gaplessly and become
-- visible in position order; a reader paging by position can never skip a
-- position that commits later.
CREATE TABLE ${s}.partition_head (
  id             smallint PRIMARY KEY CHECK (id = 1),
  last_position  bigint NOT NULL CHECK (last_position >= 0)
);
INSERT INTO ${s}.partition_head (id, last_position) VALUES (1, 0);

CREATE TABLE ${s}.streams (
  stream_id    text PRIMARY KEY,
  revision     integer NOT NULL CHECK (revision >= 0),
  owner_epoch  bigint NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0),
  created_at   text NOT NULL,
  updated_at   text NOT NULL
);

CREATE TABLE ${s}.events (
  global_position  bigint PRIMARY KEY CHECK (global_position > 0),
  stream_id        text NOT NULL REFERENCES ${s}.streams (stream_id),
  seq              integer NOT NULL CHECK (seq > 0),
  id               text NOT NULL UNIQUE,
  type             text NOT NULL,
  v                integer NOT NULL CHECK (v > 0),
  ts               text NOT NULL,
  actor            text NOT NULL,
  tenant           text NOT NULL,
  project          text,
  causation_id     text,
  correlation_id   text,
  lane             text,
  payload_codec    text NOT NULL,
  data             text NOT NULL,
  metadata_codec   text NOT NULL,
  meta             text NOT NULL,
  idempotency_key  text,
  UNIQUE (stream_id, seq)
);
CREATE UNIQUE INDEX events_stream_idempotency
  ON ${s}.events (stream_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX events_type_position ON ${s}.events (type, global_position);
CREATE INDEX events_tenant_position ON ${s}.events (tenant, global_position);
CREATE INDEX events_stream_position ON ${s}.events (stream_id, global_position);

CREATE TABLE ${s}.snapshots (
  stream_id    text NOT NULL REFERENCES ${s}.streams (stream_id),
  seq          integer NOT NULL CHECK (seq >= 0),
  state_codec  text NOT NULL,
  state        text NOT NULL,
  saved_at     text NOT NULL,
  PRIMARY KEY (stream_id, seq)
);

CREATE TABLE ${s}.subscription_leases (
  subscription_id  text NOT NULL,
  partition_id     text NOT NULL,
  holder_id        text NOT NULL,
  fence_token      bigint NOT NULL CHECK (fence_token > 0),
  expires_at       text NOT NULL,
  released         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (subscription_id, partition_id)
);

CREATE TABLE ${s}.subscription_checkpoints (
  subscription_id  text NOT NULL,
  partition_id     text NOT NULL,
  position         bigint NOT NULL CHECK (position >= 0),
  fence_token      bigint NOT NULL CHECK (fence_token > 0),
  updated_at       text NOT NULL,
  PRIMARY KEY (subscription_id, partition_id)
);

CREATE TABLE ${s}.checkpoint_log (
  subscription_id  text NOT NULL,
  partition_id     text NOT NULL,
  entry            bigint NOT NULL CHECK (entry > 0),
  position         bigint NOT NULL CHECK (position >= 0),
  fence_token      bigint NOT NULL CHECK (fence_token > 0),
  holder_id        text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('advance', 'reset')),
  committed_at     text NOT NULL,
  PRIMARY KEY (subscription_id, partition_id, entry)
);

CREATE TABLE ${s}.queue_messages (
  message_id        text PRIMARY KEY,
  queue_name        text NOT NULL,
  actor_key         text,
  idempotency_key   text NOT NULL,
  body_codec        text NOT NULL,
  body              text NOT NULL,
  state             text NOT NULL CHECK (state IN ('pending', 'leased', 'completed')),
  available_at      text NOT NULL,
  delivery_attempt  integer NOT NULL DEFAULT 0,
  lease_id          text,
  lease_fence       bigint,
  lease_expires_at  text,
  completed_at      text,
  created_position  bigint,
  UNIQUE (queue_name, idempotency_key)
);

CREATE TABLE ${s}.durable_timers (
  timer_id          text PRIMARY KEY,
  timer_kind        text NOT NULL CHECK (timer_kind IN ('sleep', 'reminder')),
  subject_id        text NOT NULL,
  idempotency_key   text NOT NULL,
  due_at            text NOT NULL,
  occurrence        integer NOT NULL DEFAULT 0,
  payload_codec     text NOT NULL,
  payload           text NOT NULL,
  fired_at          text,
  created_position  bigint,
  UNIQUE (subject_id, idempotency_key)
);

CREATE TABLE ${s}.cron_schedules (
  schedule_id   text PRIMARY KEY,
  every_ms      bigint NOT NULL CHECK (every_ms > 0),
  start_at      text NOT NULL,
  next_fire_at  text NOT NULL,
  occurrence    integer NOT NULL DEFAULT 0,
  updated_at    text NOT NULL
);

CREATE TABLE ${s}.outbox (
  outbox_id         text PRIMARY KEY,
  destination       text NOT NULL,
  idempotency_key   text NOT NULL,
  payload_codec     text NOT NULL,
  payload           text NOT NULL,
  headers_codec     text NOT NULL,
  headers           text NOT NULL,
  state             text NOT NULL CHECK (state IN ('pending', 'leased', 'acked')),
  available_at      text NOT NULL,
  attempt_count     integer NOT NULL DEFAULT 0,
  lease_id          text,
  lease_fence       bigint,
  lease_expires_at  text,
  acknowledged_at   text,
  created_position  bigint,
  UNIQUE (destination, idempotency_key)
);
`;
}

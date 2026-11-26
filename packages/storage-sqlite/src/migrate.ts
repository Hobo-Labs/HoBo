import { EventStoreError, UnsupportedSchemaVersionError } from "@hobo/core";
import {
	DEFAULT_METADATA_CODEC,
	DEFAULT_PAYLOAD_CODEC,
	DEFAULT_STATE_CODEC,
	encodeJson,
	encodeLegacyJsonText,
} from "./codec.js";
import { asNumber, asText, type SqliteDriver } from "./driver.js";
import type { JsonValue } from "./json.js";
import {
	LEGACY_SCHEMA_VERSION,
	SCHEMA_V2_SQL,
	SCHEMA_VERSION,
} from "./schema.js";

export interface MigrationReport {
	readonly fromVersion: number;
	readonly toVersion: number;
	readonly streamsMigrated: number;
	readonly eventsMigrated: number;
	readonly snapshotsMigrated: number;
	readonly alreadyCurrent: boolean;
}

export class MigrationFailureError extends EventStoreError {
	constructor(message: string) {
		super("MIGRATION_FAILURE", message);
		this.name = "MigrationFailureError";
	}
}

export class StreamIntegrityError extends EventStoreError {
	constructor(message: string) {
		super("STREAM_INTEGRITY", message);
		this.name = "StreamIntegrityError";
	}
}

function userVersion(db: SqliteDriver): number {
	const row = db.prepare("PRAGMA user_version").get();
	if (!row) return 0;
	const key = Object.keys(row)[0] ?? "user_version";
	return asNumber(row[key], "user_version");
}

function setUserVersion(db: SqliteDriver, version: number): void {
	db.exec(`PRAGMA user_version = ${version}`);
}

function tableExists(db: SqliteDriver, name: string): boolean {
	const row = db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get(name);
	return row !== undefined;
}

function hasV2Streams(db: SqliteDriver): boolean {
	return tableExists(db, "streams");
}

function hasLegacyEvents(db: SqliteDriver): boolean {
	if (!tableExists(db, "events")) return false;
	// v1 events have TEXT data column and no global_position
	const info = db.prepare(`PRAGMA table_info(events)`).all();
	const cols = new Set(info.map((r) => asText(r.name, "name")));
	return (
		cols.has("data") &&
		!cols.has("global_position") &&
		!cols.has("payload_codec")
	);
}

/**
 * Open-path migration: 0/empty → v2; legacy v1 → v2; v2 → no-op;
 * newer than supported → fail closed.
 */
export function migrateToCurrent(
	db: SqliteDriver,
	options: { now?: string } = {},
): MigrationReport {
	const now = options.now ?? new Date().toISOString();
	const version = userVersion(db);

	if (version > SCHEMA_VERSION) {
		throw new UnsupportedSchemaVersionError(version, SCHEMA_VERSION);
	}

	if (version === SCHEMA_VERSION && hasV2Streams(db)) {
		return {
			fromVersion: version,
			toVersion: SCHEMA_VERSION,
			streamsMigrated: 0,
			eventsMigrated: 0,
			snapshotsMigrated: 0,
			alreadyCurrent: true,
		};
	}

	// Fresh DB or partially initialized
	if (version === 0 && !tableExists(db, "events")) {
		db.beginImmediate();
		try {
			db.exec(SCHEMA_V2_SQL);
			setUserVersion(db, SCHEMA_VERSION);
			db.commit();
		} catch (error) {
			db.rollback();
			throw new MigrationFailureError(
				error instanceof Error ? error.message : String(error),
			);
		}
		return {
			fromVersion: 0,
			toVersion: SCHEMA_VERSION,
			streamsMigrated: 0,
			eventsMigrated: 0,
			snapshotsMigrated: 0,
			alreadyCurrent: false,
		};
	}

	// Detect legacy v1 by shape when user_version was never set (runtime-local)
	const isLegacy =
		version === 0 || version === LEGACY_SCHEMA_VERSION || hasLegacyEvents(db);

	if (isLegacy && hasLegacyEvents(db) && !hasV2Streams(db)) {
		return migrateLegacyV1ToV2(db, now);
	}

	if (version < SCHEMA_VERSION && !hasLegacyEvents(db)) {
		db.beginImmediate();
		try {
			db.exec(SCHEMA_V2_SQL);
			setUserVersion(db, SCHEMA_VERSION);
			db.commit();
		} catch (error) {
			db.rollback();
			throw new MigrationFailureError(
				error instanceof Error ? error.message : String(error),
			);
		}
		return {
			fromVersion: version,
			toVersion: SCHEMA_VERSION,
			streamsMigrated: 0,
			eventsMigrated: 0,
			snapshotsMigrated: 0,
			alreadyCurrent: false,
		};
	}

	// Already on v2 tables but version pragma lagging
	if (hasV2Streams(db)) {
		setUserVersion(db, SCHEMA_VERSION);
		return {
			fromVersion: version,
			toVersion: SCHEMA_VERSION,
			streamsMigrated: 0,
			eventsMigrated: 0,
			snapshotsMigrated: 0,
			alreadyCurrent: true,
		};
	}

	throw new MigrationFailureError(
		`unable to migrate schema from version ${version}`,
	);
}

/**
 * Migrate exact runtime-local v1 events/snapshots → v2.
 * Ordering: (stream_id ASC, seq ASC). Positions assigned in that order.
 * owner_epoch = 0 (unfenced legacy). Noncontiguous seq fails safely.
 */
function migrateLegacyV1ToV2(db: SqliteDriver, now: string): MigrationReport {
	db.beginImmediate();
	try {
		// Rename legacy tables
		db.exec(`ALTER TABLE events RENAME TO events_v1`);
		if (tableExists(db, "snapshots")) {
			db.exec(`ALTER TABLE snapshots RENAME TO snapshots_v1`);
		}

		db.exec(SCHEMA_V2_SQL);

		const streamIds = db
			.prepare(
				`SELECT DISTINCT stream_id FROM events_v1 ORDER BY stream_id ASC`,
			)
			.all()
			.map((r) => asText(r.stream_id, "stream_id"));

		let eventsMigrated = 0;
		let streamsMigrated = 0;

		for (const streamId of streamIds) {
			const rows = db
				.prepare(
					`SELECT stream_id, seq, id, type, v, ts, actor, tenant, project,
                  causation_id, correlation_id, lane, data, meta, idempotency_key
           FROM events_v1
           WHERE stream_id = ?
           ORDER BY seq ASC`,
				)
				.all(streamId);

			if (rows.length === 0) continue;

			// Contiguity check: seq must be 1..n without gaps
			for (let i = 0; i < rows.length; i++) {
				const seq = asNumber(rows[i]?.seq, "seq");
				if (seq !== i + 1) {
					throw new StreamIntegrityError(
						`noncontiguous stream ${streamId}: expected seq ${i + 1}, found ${seq}`,
					);
				}
			}

			const revision = rows.length;
			db.prepare(
				`INSERT INTO streams (stream_id, revision, owner_epoch, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?)`,
			).run(streamId, revision, now, now);
			streamsMigrated += 1;

			const insert = db.prepare(
				`INSERT INTO events (
          stream_id, seq, id, type, v, ts, actor, tenant, project,
          causation_id, correlation_id, lane, payload_codec, data,
          metadata_codec, meta, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);

			for (const row of rows) {
				const actorText = asText(row.actor, "actor");
				const dataText = asText(row.data, "data");
				const metaText =
					row.meta === null || row.meta === undefined
						? "{}"
						: asText(row.meta, "meta");

				insert.run(
					streamId,
					asNumber(row.seq, "seq"),
					asText(row.id, "id"),
					asText(row.type, "type"),
					asNumber(row.v ?? 1, "v"),
					asText(row.ts, "ts"),
					encodeJson(JSON.parse(actorText)),
					asText(row.tenant, "tenant"),
					row.project === null || row.project === undefined
						? null
						: asText(row.project, "project"),
					row.causation_id === null || row.causation_id === undefined
						? null
						: asText(row.causation_id, "causation_id"),
					row.correlation_id === null || row.correlation_id === undefined
						? null
						: asText(row.correlation_id, "correlation_id"),
					row.lane === null || row.lane === undefined
						? null
						: asText(row.lane, "lane"),
					DEFAULT_PAYLOAD_CODEC,
					new TextEncoder().encode(dataText),
					DEFAULT_METADATA_CODEC,
					new TextEncoder().encode(metaText),
					row.idempotency_key === null || row.idempotency_key === undefined
						? null
						: asText(row.idempotency_key, "idempotency_key"),
				);
				eventsMigrated += 1;
			}
		}

		let snapshotsMigrated = 0;
		if (tableExists(db, "snapshots_v1")) {
			const snaps = db
				.prepare(
					`SELECT stream_id, seq, state, saved_at FROM snapshots_v1 ORDER BY stream_id ASC`,
				)
				.all();
			const insertSnap = db.prepare(
				`INSERT INTO snapshots (stream_id, seq, state_codec, state, saved_at)
         VALUES (?, ?, ?, ?, ?)`,
			);
			for (const snap of snaps) {
				const streamId = asText(snap.stream_id, "stream_id");
				const seq = asNumber(snap.seq, "seq");
				const head = db
					.prepare(`SELECT revision FROM streams WHERE stream_id = ?`)
					.get(streamId);
				const headRev = head ? asNumber(head.revision, "revision") : 0;
				if (seq > headRev) {
					throw new StreamIntegrityError(
						`snapshot ahead of stream ${streamId}: snapshot seq ${seq} > head ${headRev}`,
					);
				}
				// Ensure stream head exists even if no events (should not happen)
				if (!head) {
					db.prepare(
						`INSERT INTO streams (stream_id, revision, owner_epoch, created_at, updated_at)
             VALUES (?, 0, 0, ?, ?)`,
					).run(streamId, now, now);
				}
				const stateText = asText(snap.state, "state");
				insertSnap.run(
					streamId,
					seq,
					DEFAULT_STATE_CODEC,
					new TextEncoder().encode(stateText),
					asText(snap.saved_at, "saved_at"),
				);
				snapshotsMigrated += 1;
			}
			db.exec(`DROP TABLE snapshots_v1`);
		}

		db.exec(`DROP TABLE events_v1`);
		setUserVersion(db, SCHEMA_VERSION);
		db.commit();

		// Post-migration integrity (outside write txn is fine; read-only checks)
		assertIntegrity(db);

		return {
			fromVersion: LEGACY_SCHEMA_VERSION,
			toVersion: SCHEMA_VERSION,
			streamsMigrated,
			eventsMigrated,
			snapshotsMigrated,
			alreadyCurrent: false,
		};
	} catch (error) {
		try {
			db.rollback();
		} catch {
			// ignore rollback errors
		}
		if (
			error instanceof MigrationFailureError ||
			error instanceof StreamIntegrityError ||
			error instanceof UnsupportedSchemaVersionError
		) {
			throw error;
		}
		throw new MigrationFailureError(
			error instanceof Error ? error.message : String(error),
		);
	}
}

export function assertIntegrity(db: SqliteDriver): void {
	const integrity = db.prepare("PRAGMA integrity_check").get();
	const integrityValue = integrity
		? String(Object.values(integrity)[0] ?? "")
		: "";
	if (integrityValue !== "ok") {
		throw new EventStoreError(
			"INTEGRITY_FAILURE",
			`PRAGMA integrity_check failed: ${integrityValue}`,
		);
	}
	const fk = db.prepare("PRAGMA foreign_key_check").all();
	if (fk.length > 0) {
		throw new EventStoreError(
			"INTEGRITY_FAILURE",
			`PRAGMA foreign_key_check found ${fk.length} violation(s)`,
		);
	}
}

/** Build a legacy v1 fixture database for migration tests. */
export function installLegacyV1Fixture(
	db: SqliteDriver,
	fixture: {
		events: Array<{
			stream_id: string;
			seq: number;
			id: string;
			type: string;
			v?: number;
			ts: string;
			actor: unknown;
			tenant: string;
			project?: string | null;
			causation_id?: string | null;
			correlation_id?: string | null;
			lane?: string | null;
			data: JsonValue;
			meta?: unknown;
			idempotency_key?: string | null;
		}>;
		snapshots?: Array<{
			stream_id: string;
			seq: number;
			state: unknown;
			saved_at: string;
		}>;
	},
): void {
	db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
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
`);
	const insert = db.prepare(
		`INSERT INTO events (
      stream_id, seq, id, type, v, ts, actor, tenant, project,
      causation_id, correlation_id, lane, data, meta, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const e of fixture.events) {
		insert.run(
			e.stream_id,
			e.seq,
			e.id,
			e.type,
			e.v ?? 1,
			e.ts,
			encodeLegacyJsonText(e.actor),
			e.tenant,
			e.project ?? null,
			e.causation_id ?? null,
			e.correlation_id ?? null,
			e.lane ?? null,
			encodeLegacyJsonText(e.data),
			encodeLegacyJsonText(e.meta ?? {}),
			e.idempotency_key ?? null,
		);
	}
	if (fixture.snapshots) {
		const snap = db.prepare(
			`INSERT INTO snapshots (stream_id, seq, state, saved_at) VALUES (?, ?, ?, ?)`,
		);
		for (const s of fixture.snapshots) {
			snap.run(s.stream_id, s.seq, encodeLegacyJsonText(s.state), s.saved_at);
		}
	}
	// Legacy never set user_version (stays 0)
}

import { DatabaseSync } from "node:sqlite";
import { isJsonBigInt, isJsonNumber, isJsonString } from "./json.js";

import type {
	AcceptCommandInput,
	AcceptCommandResult,
	InboxCommand,
	JournalFact,
	RivetInboxStatus,
} from "./types.js";
import { RivetJournalError } from "./types.js";

export type SqliteValue =
	| null
	| number
	| bigint
	| string
	| Uint8Array
	| boolean;

export interface SqliteRow {
	readonly [key: string]: SqliteValue | undefined;
}

function asBytes(value: SqliteValue | undefined): Uint8Array {
	if (value instanceof Uint8Array) return value;
	throw new RivetJournalError("PARSE", "event payload must be a blob");
}

function asNumber(value: SqliteValue | undefined): number {
	if (isJsonNumber(value) && Number.isFinite(value)) return value;
	if (isJsonBigInt(value)) return Number(value);
	if (isJsonString(value) && value !== "" && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return 0;
}

function asBigInt(value: SqliteValue | undefined): bigint {
	if (isJsonBigInt(value)) return value;
	if (isJsonNumber(value) && Number.isSafeInteger(value)) return BigInt(value);
	if (isJsonString(value) && /^-?\d+$/.test(value)) return BigInt(value);
	return 0n;
}

function parseInboxStatus(value: SqliteValue | undefined): RivetInboxStatus {
	if (
		value === "persisted" ||
		value === "processing" ||
		value === "committed" ||
		value === "completed" ||
		value === "failed-retryable" ||
		value === "failed-terminal"
	) {
		return value;
	}
	throw new RivetJournalError("PARSE", `invalid inbox status ${String(value)}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hobo_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hobo_actor_head (
  stream_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  owner_epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hobo_actor_lease (
  stream_id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hobo_events (
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload BLOB NOT NULL,
  metadata_json TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  tenant TEXT NOT NULL,
  project TEXT,
  lane TEXT,
  PRIMARY KEY (stream_id, seq)
);
CREATE TABLE IF NOT EXISTS hobo_inbox (
  stream_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  PRIMARY KEY (stream_id, command_id)
);
CREATE TABLE IF NOT EXISTS hobo_outbox (
  stream_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (stream_id, effect_id)
);
`;

export interface ActorLocalJournal {
	readonly driver: "node-sqlite";
	close(): void;
	transaction<T>(fn: () => T): T;
	head(streamId: string): { revision: number; ownerEpoch: bigint };
	acquireLease(
		streamId: string,
		holderId: string,
		nowMs: number,
		ttlMs: number,
	): { fenceToken: bigint; expiresAtMs: number } | undefined;
	releaseLease(streamId: string, holderId: string, fenceToken: bigint): boolean;
	appendLeased(
		streamId: string,
		holderId: string,
		fenceToken: bigint,
		nowMs: number,
		facts: readonly JournalFact[],
	): { revision: number } | undefined;
	append(
		streamId: string,
		expectedRevision: number,
		facts: readonly JournalFact[],
	): { revision: number };
	readFacts(streamId: string, fromSeq?: number): readonly JournalFactRecord[];
	acceptCommand(input: AcceptCommandInput): AcceptCommandResult;
	claimNext(streamId: string): InboxCommand | undefined;
	rejectCommand(
		streamId: string,
		commandId: string,
		resultJson: string,
	): boolean;

	commitCommand(input: {
		readonly streamId: string;
		readonly commandId: string;
		readonly expectedRevision: number;
		readonly facts: readonly JournalFact[];
		readonly effects?: readonly {
			readonly effectId: string;
			readonly digest: string;
			readonly payloadJson: string;
		}[];
	}): { revision: number };
	completeCommand(
		streamId: string,
		commandId: string,
		resultJson: string,
	): void;
	loadCommand(streamId: string, commandId: string): InboxCommand | undefined;
	stageOutbox(
		streamId: string,
		effectId: string,
		digest: string,
		payloadJson: string,
	): void;
	markOutboxDelivered(
		streamId: string,
		effectId: string,
		digest: string,
	): boolean;
	pendingOutbox(streamId: string): readonly {
		effectId: string;
		digest: string;
		payloadJson: string;
	}[];
}

export interface JournalFactRecord extends JournalFact {
	readonly seq: number;
}

export function createActorLocalJournal(path = ":memory:"): ActorLocalJournal {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = FULL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(SCHEMA);
	db.prepare(
		`INSERT OR IGNORE INTO hobo_schema_meta(key, value) VALUES ('version', '1')`,
	).run();

	const getHead = db.prepare(
		`SELECT revision, owner_epoch FROM hobo_actor_head WHERE stream_id = ?`,
	);
	const insertHead = db.prepare(
		`INSERT OR IGNORE INTO hobo_actor_head(stream_id, revision, owner_epoch)
     VALUES (?, 0, 0)`,
	);
	const getLease = db.prepare(
		`SELECT holder_id, owner_epoch, expires_at_ms FROM hobo_actor_lease WHERE stream_id = ?`,
	);
	const putLease = db.prepare(
		`INSERT INTO hobo_actor_lease(stream_id, holder_id, owner_epoch, expires_at_ms) VALUES (?, ?, ?, ?)
		 ON CONFLICT(stream_id) DO UPDATE SET holder_id = excluded.holder_id, owner_epoch = excluded.owner_epoch, expires_at_ms = excluded.expires_at_ms`,
	);
	const removeLease = db.prepare(
		`DELETE FROM hobo_actor_lease WHERE stream_id = ? AND holder_id = ? AND owner_epoch = ?`,
	);
	const updateOwnerEpoch = db.prepare(
		`UPDATE hobo_actor_head SET owner_epoch = ? WHERE stream_id = ?`,
	);
	const casHead = db.prepare(
		`UPDATE hobo_actor_head SET revision = ?
     WHERE stream_id = ? AND revision = ?`,
	);
	const insertEvent = db.prepare(
		`INSERT INTO hobo_events(
        stream_id, seq, event_id, type, payload, metadata_json,
        causation_id, correlation_id, tenant, project, lane
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const readEvents = db.prepare(
		`SELECT seq, event_id, type, payload, metadata_json, causation_id,
            correlation_id, tenant, project, lane
     FROM hobo_events WHERE stream_id = ? AND seq >= ? ORDER BY seq ASC`,
	);
	const getInbox = db.prepare(
		`SELECT command_id, digest, command_type, payload_json, expected_revision,
            status, attempt, result_json
     FROM hobo_inbox WHERE stream_id = ? AND command_id = ?`,
	);
	const insertInbox = db.prepare(
		`INSERT INTO hobo_inbox(
        stream_id, command_id, digest, command_type, payload_json,
        expected_revision, status, attempt
      ) VALUES (?, ?, ?, ?, ?, ?, 'persisted', 0)`,
	);
	const nextInbox = db.prepare(
		`SELECT command_id, digest, command_type, payload_json, expected_revision,
            status, attempt, result_json
     FROM hobo_inbox
     WHERE stream_id = ? AND status IN ('persisted', 'processing', 'committed')
     ORDER BY command_id ASC LIMIT 1`,
	);
	const claimInbox = db.prepare(
		`UPDATE hobo_inbox SET status = 'processing', attempt = attempt + 1
     WHERE stream_id = ? AND command_id = ? AND status IN ('persisted', 'processing')`,
	);
	const commitInboxWithReceipt = db.prepare(
		`UPDATE hobo_inbox SET status = 'committed', result_json = ?
     WHERE stream_id = ? AND command_id = ? AND status IN ('persisted', 'processing')`,
	);
	const rejectInbox = db.prepare(
		`UPDATE hobo_inbox SET status = 'failed-terminal', result_json = ?
     WHERE stream_id = ? AND command_id = ? AND status IN ('persisted', 'processing')`,
	);
	const completeInbox = db.prepare(
		`UPDATE hobo_inbox SET status = 'completed', result_json = ?
     WHERE stream_id = ? AND command_id = ?`,
	);
	const insertOutbox = db.prepare(
		`INSERT INTO hobo_outbox(stream_id, effect_id, digest, payload_json, status)
     VALUES (?, ?, ?, ?, 'pending')`,
	);
	const listOutbox = db.prepare(
		`SELECT effect_id, digest, payload_json FROM hobo_outbox
     WHERE stream_id = ? AND status = 'pending' ORDER BY effect_id`,
	);
	const getOutbox = db.prepare(
		`SELECT digest, payload_json, status FROM hobo_outbox WHERE stream_id = ? AND effect_id = ?`,
	);
	const acknowledgeOutbox = db.prepare(
		`UPDATE hobo_outbox SET status = 'delivered' WHERE stream_id = ? AND effect_id = ? AND digest = ? AND status = 'pending'`,
	);

	function stageOutboxEffect(
		streamId: string,
		effectId: string,
		digest: string,
		payloadJson: string,
	): void {
		if (!streamId.trim() || !effectId.trim() || !digest.trim())
			throw new RivetJournalError(
				"PARSE",
				"outbox stream, effect id, and digest are required",
			);
		try {
			JSON.parse(payloadJson);
		} catch {
			throw new RivetJournalError("PARSE", "outbox payload must be valid JSON");
		}
		const existing = getOutbox.get(streamId, effectId) as SqliteRow | undefined;
		if (existing) {
			if (existing.digest !== digest || existing.payload_json !== payloadJson)
				throw new RivetJournalError(
					"DIGEST_MISMATCH",
					`outbox effect ${effectId} digest mismatch`,
				);
			if (existing.status !== "pending" && existing.status !== "delivered")
				throw new RivetJournalError(
					"PARSE",
					`invalid outbox status for ${effectId}`,
				);
			return;
		}
		insertOutbox.run(streamId, effectId, digest, payloadJson);
	}

	function leaseEpoch(value: SqliteValue | undefined): bigint {
		let epoch: bigint;
		if (isJsonBigInt(value)) epoch = value;
		else if (isJsonNumber(value) && Number.isSafeInteger(value))
			epoch = BigInt(value);
		else if (isJsonString(value) && /^\d+$/u.test(value)) epoch = BigInt(value);
		else throw new RivetJournalError("PARSE", "invalid actor lease epoch");
		if (epoch < 0n || epoch > BigInt(Number.MAX_SAFE_INTEGER))
			throw new RivetJournalError("PARSE", "actor lease epoch is out of range");
		return epoch;
	}

	function appendAtRevision(
		streamId: string,
		expectedRevision: number,
		facts: readonly JournalFact[],
	) {
		insertHead.run(streamId);
		const head = getHead.get(streamId) as SqliteRow | undefined;
		const current = asNumber(head?.revision);
		if (current !== expectedRevision)
			throw new RivetJournalError(
				"STALE_REVISION",
				`expected revision ${expectedRevision}, found ${current}`,
			);
		let seq = current;
		for (const fact of facts) {
			seq += 1;
			insertEvent.run(
				streamId,
				seq,
				fact.eventId,
				fact.type,
				fact.payload,
				fact.metadataJson,
				fact.causationId ?? null,
				fact.correlationId ?? null,
				fact.tenant,
				fact.project ?? null,
				fact.lane ?? null,
			);
		}
		if (casHead.run(seq, streamId, current).changes !== 1)
			throw new RivetJournalError(
				"STALE_REVISION",
				`cas failed at revision ${current}`,
			);
		return { revision: seq };
	}

	const mapInbox = (row: SqliteRow): InboxCommand => ({
		commandId: String(row.command_id),
		digest: String(row.digest),
		commandType: String(row.command_type),
		payloadJson: String(row.payload_json),
		expectedRevision: asNumber(row.expected_revision),
		status: parseInboxStatus(row.status),
		attempt: asNumber(row.attempt),
		...(row.result_json != null
			? { resultJson: String(row.result_json) }
			: undefined),
	});

	return {
		driver: "node-sqlite",
		close() {
			db.close();
		},
		transaction<T>(fn: () => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		head(streamId) {
			insertHead.run(streamId);

			const row = getHead.get(streamId) as SqliteRow | undefined;
			return {
				revision: asNumber(row?.revision),
				ownerEpoch: asBigInt(row?.owner_epoch),
			};
		},
		acquireLease(streamId, holderId, nowMs, ttlMs) {
			if (
				!streamId.trim() ||
				!holderId.trim() ||
				!Number.isSafeInteger(nowMs) ||
				!Number.isSafeInteger(ttlMs) ||
				ttlMs <= 0 ||
				!Number.isSafeInteger(nowMs + ttlMs)
			)
				throw new RivetJournalError("PARSE", "invalid actor lease request");
			return this.transaction(() => {
				insertHead.run(streamId);
				const held = getLease.get(streamId) as SqliteRow | undefined;
				if (held && asNumber(held.expires_at_ms) > nowMs) return undefined;
				const head = getHead.get(streamId) as SqliteRow | undefined;
				const fenceToken = leaseEpoch(head?.owner_epoch) + 1n;
				if (fenceToken > BigInt(Number.MAX_SAFE_INTEGER))
					throw new RivetJournalError(
						"PARSE",
						"actor lease epoch is exhausted",
					);
				const expiresAtMs = nowMs + ttlMs;
				updateOwnerEpoch.run(fenceToken, streamId);
				putLease.run(streamId, holderId, fenceToken, expiresAtMs);
				return { fenceToken, expiresAtMs };
			});
		},
		releaseLease(streamId, holderId, fenceToken) {
			return this.transaction(
				() => removeLease.run(streamId, holderId, fenceToken).changes === 1,
			);
		},
		appendLeased(streamId, holderId, fenceToken, nowMs, facts) {
			if (!Number.isSafeInteger(nowMs))
				throw new RivetJournalError("PARSE", "invalid actor lease clock");
			return this.transaction(() => {
				const held = getLease.get(streamId) as SqliteRow | undefined;
				const head = getHead.get(streamId) as SqliteRow | undefined;
				if (
					!held ||
					!head ||
					held.holder_id !== holderId ||
					leaseEpoch(held.owner_epoch) !== fenceToken ||
					leaseEpoch(head.owner_epoch) !== fenceToken ||
					asNumber(held.expires_at_ms) <= nowMs
				)
					return undefined;
				return appendAtRevision(streamId, asNumber(head.revision), facts);
			});
		},
		append(streamId, expectedRevision, facts) {
			return this.transaction(() =>
				appendAtRevision(streamId, expectedRevision, facts),
			);
		},
		readFacts(streamId, fromSeq = 1) {
			const rows = readEvents.all(streamId, fromSeq) as SqliteRow[];
			return rows.map((row) => ({
				seq: asNumber(row.seq),
				eventId: String(row.event_id),
				type: String(row.type),
				payload: asBytes(row.payload),
				metadataJson: String(row.metadata_json),
				...(row.causation_id != null
					? { causationId: String(row.causation_id) }
					: undefined),
				...(row.correlation_id != null
					? { correlationId: String(row.correlation_id) }
					: undefined),
				tenant: String(row.tenant),
				...(row.project != null ? { project: String(row.project) } : undefined),
				...(row.lane != null ? { lane: String(row.lane) } : undefined),
			}));
		},
		acceptCommand(input) {
			return this.transaction(() => {
				const existing = getInbox.get(input.streamId, input.commandId) as
					| SqliteRow
					| undefined;
				if (existing) {
					if (String(existing.digest) !== input.digest) {
						throw new RivetJournalError(
							"DIGEST_MISMATCH",
							`command ${input.commandId} digest mismatch`,
						);
					}
					return {
						status: parseInboxStatus(existing.status),
						duplicate: true,
						...(existing.result_json != null
							? { resultJson: String(existing.result_json) }
							: undefined),
					};
				}
				insertInbox.run(
					input.streamId,
					input.commandId,
					input.digest,
					input.commandType,
					input.payloadJson,
					input.expectedRevision,
				);
				return { status: "persisted" as const, duplicate: false };
			});
		},
		claimNext(streamId) {
			return this.transaction(() => {
				const row = nextInbox.get(streamId) as SqliteRow | undefined;
				if (!row) return undefined;
				const commandId = String(row.command_id);
				claimInbox.run(streamId, commandId);

				const claimed = getInbox.get(streamId, commandId) as SqliteRow;
				return mapInbox(claimed);
			});
		},
		rejectCommand(streamId, commandId, resultJson) {
			return this.transaction(
				() => rejectInbox.run(resultJson, streamId, commandId).changes === 1,
			);
		},
		commitCommand(input) {
			return this.transaction(() => {
				const inbox = getInbox.get(input.streamId, input.commandId) as
					| SqliteRow
					| undefined;
				if (
					!inbox ||
					(parseInboxStatus(inbox.status) !== "persisted" &&
						parseInboxStatus(inbox.status) !== "processing")
				)
					throw new RivetJournalError(
						"INBOX_CONFLICT",
						`command ${input.commandId} is not pending`,
					);
				if (asNumber(inbox.expected_revision) !== input.expectedRevision)
					throw new RivetJournalError(
						"INBOX_CONFLICT",
						`command ${input.commandId} expected revision does not match its inbox entry`,
					);
				insertHead.run(input.streamId);

				const commitHead = getHead.get(input.streamId) as SqliteRow | undefined;
				const current = asNumber(commitHead?.revision);
				if (current !== input.expectedRevision) {
					throw new RivetJournalError(
						"STALE_REVISION",
						`expected revision ${input.expectedRevision}, found ${current}`,
					);
				}
				let seq = current;
				for (const fact of input.facts) {
					seq += 1;
					insertEvent.run(
						input.streamId,
						seq,
						fact.eventId,
						fact.type,
						fact.payload,
						fact.metadataJson,
						fact.causationId ?? null,
						fact.correlationId ?? null,
						fact.tenant,
						fact.project ?? null,
						fact.lane ?? null,
					);
				}
				const updated = casHead.run(seq, input.streamId, current);
				if (updated.changes !== 1) {
					throw new RivetJournalError(
						"STALE_REVISION",
						`cas failed at revision ${current}`,
					);
				}
				const committed = commitInboxWithReceipt.run(
					JSON.stringify({ revision: seq }),
					input.streamId,
					input.commandId,
				);
				if (committed.changes !== 1)
					throw new RivetJournalError(
						"INBOX_CONFLICT",
						`command ${input.commandId} is not pending`,
					);
				for (const effect of input.effects ?? []) {
					stageOutboxEffect(
						input.streamId,
						effect.effectId,
						effect.digest,
						effect.payloadJson,
					);
				}
				return { revision: seq };
			});
		},
		completeCommand(streamId, commandId, resultJson) {
			this.transaction(() => {
				completeInbox.run(resultJson, streamId, commandId);
			});
		},
		loadCommand(streamId, commandId) {
			const row = getInbox.get(streamId, commandId) as SqliteRow | undefined;
			return row ? mapInbox(row) : undefined;
		},
		stageOutbox(streamId, effectId, digest, payloadJson) {
			this.transaction(() => {
				stageOutboxEffect(streamId, effectId, digest, payloadJson);
			});
		},
		markOutboxDelivered(streamId, effectId, digest) {
			return this.transaction(() => {
				if (acknowledgeOutbox.run(streamId, effectId, digest).changes === 1)
					return true;
				const existing = getOutbox.get(streamId, effectId) as
					| SqliteRow
					| undefined;
				if (!existing)
					throw new RivetJournalError(
						"INBOX_CONFLICT",
						`outbox effect ${effectId} is missing`,
					);
				if (existing.digest !== digest)
					throw new RivetJournalError(
						"DIGEST_MISMATCH",
						`outbox effect ${effectId} digest mismatch`,
					);
				if (existing.status !== "delivered")
					throw new RivetJournalError(
						"PARSE",
						`invalid outbox status for ${effectId}`,
					);
				return false;
			});
		},
		pendingOutbox(streamId) {
			const rows = listOutbox.all(streamId) as SqliteRow[];
			return rows.map((row) => ({
				effectId: String(row.effect_id),
				digest: String(row.digest),
				payloadJson: String(row.payload_json),
			}));
		},
	};
}

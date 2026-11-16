import type {
	AppendOptions,
	AppendResult,
	ClaimSubscriptionOptions,
	Clock,
	DurableCommitRequest,
	DurableCommitResult,
	DurableEffectInput,
	DurableEffectReceipt,
	EventEnvelope,
	EventInput,
	EventPosition,
	FenceToken,
	PartitionId,
	PositionedEvent,
	ReadAllOptions,
	SnapshotRecord,
	StreamFilter,
	SubscriptionCheckpoint,
	SubscriptionId,
	SubscriptionLease,
} from "@hobo/core";
import {
	CheckpointRegressionError,
	EVENTSTORE_LIMITS,
	FENCING_COMPAT,
	MissingFenceError,
	OptimisticSequenceConflictError,
	parseEventEnvelope,
	parseEventPosition,
	parseFenceToken,
	parsePartitionId,
	parseSubscriptionId,
	SnapshotAheadError,
	StaleFenceError,
} from "@hobo/core";
import {
	DEFAULT_METADATA_CODEC,
	DEFAULT_PAYLOAD_CODEC,
	DEFAULT_STATE_CODEC,
	type DecodedPayload,
	decodeJson,
	decodeMetadata,
	decodePayload,
	encodeJson,
	encodeMetadata,
	encodePayload,
} from "./codec.js";
import {
	asBigInt,
	asBytes,
	asNumber,
	asText,
	type SqliteDriver,
	type SqliteRow,
	type SqliteValue,
} from "./driver.js";
import { createDeterministicId, createUlidGenerator } from "./ids.js";
import {
	asJsonObject,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { migrateToCurrent } from "./migrate.js";
import { NATIVE_PRAGMAS } from "./schema.js";

export interface JournalOpenOptions {
	readonly clock?: Clock;
	readonly partitionId?: string;
	/** Apply native WAL/FULL pragmas (default true for node drivers). */
	readonly nativePragmas?: boolean;
	readonly now?: string;
}

export interface ParsedEventInput {
	readonly type: string;
	readonly v: number;
	readonly data: JsonValue;
	readonly meta: JsonObject;
	readonly idempotencyKey?: string | undefined;
}

export interface EnqueueMessageResult {
	readonly messageId: string;
	readonly deduped: boolean;
}

export interface QueueEnqueueInput {
	queueName: string;
	idempotencyKey: string;
	body: JsonValue;
	availableAt?: string;
	actorKey?: string;
	messageId?: string;
}

export interface ActorLease {
	readonly key: string;
	readonly holderId: string;
	readonly fenceToken: bigint;
	readonly expiresAt: string;
}

export interface StreamHead {
	readonly streamId: string;
	readonly revision: number;
	readonly ownerEpoch: bigint;
}

/**
 * Portable SQLite journal implementing DurableEventStore semantics.
 * Driver-agnostic: Node and browser adapters supply SqliteDriver.
 */
export class SqliteJournal {
	readonly partitionId: string;
	private readonly db: SqliteDriver;
	private readonly clock: Clock;
	private readonly nextUlid: () => string;
	private readonly liveHandlers = new Set<{
		filter: StreamFilter;
		handler: (event: EventEnvelope) => void | Promise<void>;
	}>();

	constructor(db: SqliteDriver, options: JournalOpenOptions = {}) {
		this.db = db;
		this.partitionId = options.partitionId ?? "default";
		this.clock = options.clock ?? { now: () => new Date().toISOString() };

		if (options.nativePragmas !== false && db.kind === "node") {
			this.db.exec(`PRAGMA journal_mode = ${NATIVE_PRAGMAS.journal_mode}`);
			this.db.exec(`PRAGMA synchronous = ${NATIVE_PRAGMAS.synchronous}`);
			this.db.exec(`PRAGMA foreign_keys = ${NATIVE_PRAGMAS.foreign_keys}`);
			this.db.exec(`PRAGMA busy_timeout = ${NATIVE_PRAGMAS.busy_timeout}`);
		} else {
			// Browser / memory: foreign keys + busy timeout only
			try {
				this.db.exec("PRAGMA foreign_keys = ON");
			} catch {
				// some WASM builds may not support
			}
		}

		migrateToCurrent(this.db, { now: options.now ?? this.clock.now() });
		// A deterministic clock can restart at the same instant after reopen.
		// Seed from durable state, then check under the append transaction so
		// independent handles and clock rewinds cannot reuse an existing ID.
		const existing = this.db
			.prepare("SELECT COUNT(*) AS count FROM events")
			.get();
		const next = createUlidGenerator(
			this.clock,
			requireNonNegInt(
				Number(asBigInt(existing?.count ?? 0, "eventCount")),
				"eventCount",
			),
		);
		const findId = this.db.prepare("SELECT id FROM events WHERE id = ?");
		this.nextUlid = () => {
			let candidate = next();
			while (findId.get(candidate) !== undefined) candidate = next();
			return candidate;
		};
	}

	close(): void {
		this.db.close();
	}

	getDriver(): SqliteDriver {
		return this.db;
	}

	// ── EventStore surface ──────────────────────────────────────────────────

	async append(
		streamId: string,
		events: EventInput[],
		opts: AppendOptions,
	): Promise<AppendResult> {
		const result = await this.commit({
			streamId,
			events,
			append: opts,
		});
		return {
			streamId: result.streamId,
			appended: result.appended,
			deduped: result.deduped,
			...(result.firstPosition !== undefined
				? { firstPosition: result.firstPosition }
				: undefined),
			...(result.lastPosition !== undefined
				? { lastPosition: result.lastPosition }
				: undefined),
		};
	}

	async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
		const streamId = requireNonEmpty(request.streamId, "streamId");
		const opts = request.append;
		const inputs = parseEventInputs(request.events);
		const effects = request.effects ?? [];
		if (inputs.length > EVENTSTORE_LIMITS.maxBatchEvents) {
			throw new TypeError(
				`events batch exceeds maxBatchEvents=${EVENTSTORE_LIMITS.maxBatchEvents}`,
			);
		}

		const now = this.clock.now();
		const deduped: EventEnvelope[] = [];
		const pending: ParsedEventInput[] = [];
		const pendingByKey = new Map<string, ParsedEventInput>();
		const pendingDuplicateKeys: string[] = [];

		// Pre-txn idempotency lookup for already-committed keys (also re-checked in txn)
		for (const input of inputs) {
			if (input.idempotencyKey) {
				const existing = this.findByIdempotencyKey(
					streamId,
					input.idempotencyKey,
				);
				if (existing) {
					deduped.push(existing);
					continue;
				}
				if (pendingByKey.has(input.idempotencyKey)) {
					pendingDuplicateKeys.push(input.idempotencyKey);
					continue;
				}
				pendingByKey.set(input.idempotencyKey, input);
			}
			pending.push(input);
		}

		if (pending.length === 0 && effects.length === 0) {
			return Object.freeze({
				streamId,
				appended: [],
				deduped: cloneJson(deduped),
				effects: [],
			});
		}

		// All-deduped with no new events: still allow effects; expectedSeq not required
		// to match head when every input was an already-committed idempotent retry.
		const allDeduped = pending.length === 0;

		this.db.beginImmediate();
		try {
			// Ensure stream head
			this.db
				.prepare(
					`INSERT OR IGNORE INTO streams (stream_id, revision, owner_epoch, created_at, updated_at)
           VALUES (?, 0, 0, ?, ?)`,
				)
				.run(streamId, now, now);

			const headRow = this.db
				.prepare(
					`SELECT revision, owner_epoch FROM streams WHERE stream_id = ?`,
				)
				.get(streamId);
			if (!headRow) {
				throw new Error(`stream head missing for ${streamId}`);
			}
			const revision = asNumber(headRow.revision, "revision");
			const ownerEpoch = asBigInt(headRow.owner_epoch, "owner_epoch");

			// Re-resolve idempotency inside txn
			const toWrite: ParsedEventInput[] = [];
			const txnDeduped: EventEnvelope[] = [...deduped];
			for (const input of pending) {
				if (input.idempotencyKey) {
					const existing = this.findByIdempotencyKey(
						streamId,
						input.idempotencyKey,
					);
					if (existing) {
						txnDeduped.push(existing);
						continue;
					}
				}
				toWrite.push(input);
			}

			// Fencing
			const fence = opts.fenceToken;
			let nextOwnerEpoch = ownerEpoch;
			if (ownerEpoch > FENCING_COMPAT.UNFENCED_EPOCH) {
				if (fence === undefined) {
					throw new MissingFenceError(streamId, ownerEpoch);
				}
				const provided = asBigInt(fence, "fenceToken");
				if (provided < ownerEpoch) {
					throw new StaleFenceError(streamId, provided, ownerEpoch);
				}
				if (provided > ownerEpoch) {
					nextOwnerEpoch = provided;
				}
			} else if (fence !== undefined) {
				const provided = asBigInt(fence, "fenceToken");
				if (provided > 0n) {
					nextOwnerEpoch = provided;
				}
			}

			// expectedSeq CAS — only for new events
			if (toWrite.length > 0) {
				const expectedSeq = requireNonNegInt(opts.expectedSeq, "expectedSeq");
				if (revision !== expectedSeq) {
					throw new OptimisticSequenceConflictError(
						streamId,
						expectedSeq,
						revision,
					);
				}
			} else if (!allDeduped && effects.length === 0) {
				// no-op
			}

			const appended: EventEnvelope[] = [];
			let firstPosition: EventPosition | undefined;
			let lastPosition: EventPosition | undefined;
			let nextSeq = revision + 1;

			const insertEvent = this.db.prepare(
				`INSERT INTO events (
          stream_id, seq, id, type, v, ts, actor, tenant, project,
          causation_id, correlation_id, lane, payload_codec, data,
          metadata_codec, meta, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);

			for (const input of toWrite) {
				const envelope = this.createEnvelope(input, nextSeq, streamId, opts);
				const actorBytes = encodeJson(envelope.actor);
				const dataBytes = encodePayload(DEFAULT_PAYLOAD_CODEC, envelope.data);
				const metaBytes = encodeMetadata(
					DEFAULT_METADATA_CODEC,
					asJsonObject(envelope.meta ?? {}),
				);
				const result = insertEvent.run(
					envelope.streamId,
					envelope.seq,
					envelope.id,
					envelope.type,
					envelope.v,
					envelope.ts,
					actorBytes,
					envelope.tenant,
					envelope.project ?? null,
					envelope.causationId ?? null,
					envelope.correlationId ?? null,
					envelope.lane ?? null,
					DEFAULT_PAYLOAD_CODEC,
					dataBytes,
					DEFAULT_METADATA_CODEC,
					metaBytes,
					input.idempotencyKey ?? null,
				);
				// SAFETY: assertion required at this I/O or test boundary.
				const position = asBigInt(
					result.lastInsertRowid,
					"global_position",
				) as EventPosition;
				if (firstPosition === undefined) firstPosition = position;
				lastPosition = position;
				appended.push(envelope);
				nextSeq += 1;
			}

			// Advance stream head with CAS on revision
			if (toWrite.length > 0 || nextOwnerEpoch !== ownerEpoch) {
				const newRevision = revision + toWrite.length;
				const update = this.db
					.prepare(
						`UPDATE streams
             SET revision = ?, owner_epoch = ?, updated_at = ?
             WHERE stream_id = ? AND revision = ? AND owner_epoch = ?`,
					)
					.run(
						newRevision,
						nextOwnerEpoch,
						now,
						streamId,
						revision,
						ownerEpoch,
					);
				if (update.changes !== 1) {
					throw new OptimisticSequenceConflictError(
						streamId,
						opts.expectedSeq,
						revision,
					);
				}
			}

			// Stage durable effects
			const effectReceipts: DurableEffectReceipt[] = [];
			const createdPosition = lastPosition ?? 0n;
			for (const effect of effects) {
				effectReceipts.push(this.stageEffect(effect, now, createdPosition));
			}

			// In-batch duplicate keys → deduped as the just-appended event
			const appendedByKey = new Map<string, EventEnvelope>();
			for (const envelope of appended) {
				// SAFETY: assertion required at this I/O or test boundary.
				const key = (envelope.meta as { idempotencyKey?: string } | undefined)
					?.idempotencyKey;
				if (isJsonString(key) && key.length > 0) {
					appendedByKey.set(key, envelope);
				}
			}
			for (const key of pendingDuplicateKeys) {
				const envelope = appendedByKey.get(key);
				if (envelope) txnDeduped.push(envelope);
			}

			this.db.commit();

			// Live wake only after commit
			for (const envelope of appended) {
				this.publish(envelope);
			}

			return Object.freeze({
				streamId,
				appended: cloneJson(appended),
				deduped: cloneJson(txnDeduped),
				effects: Object.freeze(effectReceipts),
				...(firstPosition !== undefined ? { firstPosition } : undefined),
				...(lastPosition !== undefined ? { lastPosition } : undefined),
			});
		} catch (error) {
			try {
				this.db.rollback();
			} catch {
				// ignore
			}
			throw error;
		}
	}

	async *read(streamId: string, fromSeq = 1): AsyncIterable<EventEnvelope> {
		const id = requireNonEmpty(streamId, "streamId");
		const start = requireNonNegInt(fromSeq, "fromSeq");
		const rows = this.db
			.prepare(
				`SELECT global_position, stream_id, seq, id, type, v, ts, actor, tenant,
                project, causation_id, correlation_id, lane, payload_codec, data,
                metadata_codec, meta
         FROM events
         WHERE stream_id = ? AND seq >= ?
         ORDER BY seq ASC`,
			)
			.all(id, start);
		for (const row of rows) {
			yield cloneJson(this.rowToEnvelope(row));
		}
	}

	async *readAll(options: ReadAllOptions = {}): AsyncIterable<PositionedEvent> {
		let after: EventPosition;
		if (options.after !== undefined) {
			after = parseEventPosition(options.after, "after");
		} else {
			const origin = 0n;
			// SAFETY: EventPosition is a branded bigint; 0n is the exclusive lower bound.
			after = origin as EventPosition;
		}
		const limit = Math.min(
			options.limit ?? EVENTSTORE_LIMITS.maxReadPage,
			EVENTSTORE_LIMITS.maxReadPage,
		);
		const params: SqliteValue[] = [after];
		const clauses = ["global_position > ?"];
		if (options.filter?.streamId) {
			clauses.push("stream_id = ?");
			params.push(options.filter.streamId);
		}
		if (options.filter?.type) {
			clauses.push("type = ?");
			params.push(options.filter.type);
		}
		if (options.tenant) {
			clauses.push("tenant = ?");
			params.push(options.tenant);
		}
		if (options.lane) {
			// lane filter: exact lane match only (no accidental baseline skip)
			clauses.push("lane = ?");
			params.push(options.lane);
		}
		params.push(limit);
		const sql = `SELECT global_position, stream_id, seq, id, type, v, ts, actor, tenant,
                project, causation_id, correlation_id, lane, payload_codec, data,
                metadata_codec, meta
         FROM events
         WHERE ${clauses.join(" AND ")}
         ORDER BY global_position ASC
         LIMIT ?`;
		const rows = this.db.prepare(sql).all(...params);
		for (const row of rows) {
			// SAFETY: assertion required at this I/O or test boundary.
			const position = asBigInt(
				row.global_position,
				"global_position",
			) as EventPosition;
			yield Object.freeze({
				position,
				event: cloneJson(this.rowToEnvelope(row)),
			});
		}
	}

	subscribe(
		filter: StreamFilter,
		handler: (event: EventEnvelope) => void | Promise<void>,
	) {
		if (!(handler instanceof Function)) {
			throw new TypeError("handler must be a function");
		}
		const sub = { filter: Object.freeze({ ...filter }), handler };
		this.liveHandlers.add(sub);
		return Object.freeze({
			unsubscribe: () => {
				this.liveHandlers.delete(sub);
			},
		});
	}

	async snapshot<S>(
		streamId: string,
		state: S,
		seq: number,
	): Promise<SnapshotRecord> {
		const id = requireNonEmpty(streamId, "streamId");
		const snapshotSeq = requireNonNegInt(seq, "seq");
		const head = this.getStreamHead(id);
		const headSeq = head?.revision ?? 0;
		if (snapshotSeq > headSeq) {
			throw new SnapshotAheadError(id, snapshotSeq, headSeq);
		}
		// Ensure stream row exists for FK
		if (!head) {
			const now = this.clock.now();
			this.db
				.prepare(
					`INSERT OR IGNORE INTO streams (stream_id, revision, owner_epoch, created_at, updated_at)
           VALUES (?, 0, 0, ?, ?)`,
				)
				.run(id, now, now);
		}
		const savedAt = this.clock.now();
		const stateBytes = encodePayload(DEFAULT_STATE_CODEC, state);
		this.db
			.prepare(
				`INSERT INTO snapshots (stream_id, seq, state_codec, state, saved_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(stream_id, seq) DO UPDATE SET
           state_codec = excluded.state_codec,
           state = excluded.state,
           saved_at = excluded.saved_at`,
			)
			.run(id, snapshotSeq, DEFAULT_STATE_CODEC, stateBytes, savedAt);
		return Object.freeze({
			streamId: id,
			seq: snapshotSeq,
			state: cloneJson(state),
			savedAt,
		});
	}

	async loadSnapshot<S>(
		streamId: string,
	): Promise<SnapshotRecord<S> | undefined> {
		const id = requireNonEmpty(streamId, "streamId");
		const row = this.db
			.prepare(
				`SELECT stream_id, seq, state_codec, state, saved_at
         FROM snapshots
         WHERE stream_id = ?
         ORDER BY seq DESC
         LIMIT 1`,
			)
			.get(id);
		if (!row) return undefined;
		const codec = asText(row.state_codec, "state_codec");
		// SAFETY: assertion required at this I/O or test boundary.
		const state = decodePayload(codec, asBytes(row.state, "state")) as S;
		return Object.freeze({
			streamId: asText(row.stream_id, "stream_id"),
			seq: asNumber(row.seq, "seq"),
			state,
			savedAt: asText(row.saved_at, "saved_at"),
		});
	}

	getStreamHead(streamId: string): StreamHead | undefined {
		const row = this.db
			.prepare(
				`SELECT stream_id, revision, owner_epoch FROM streams WHERE stream_id = ?`,
			)
			.get(streamId);
		if (!row) return undefined;
		return {
			streamId: asText(row.stream_id, "stream_id"),
			revision: asNumber(row.revision, "revision"),
			ownerEpoch: asBigInt(row.owner_epoch, "owner_epoch"),
		};
	}

	getStreamLength(streamId: string): number {
		return this.getStreamHead(streamId)?.revision ?? 0;
	}

	// ── Durable subscriptions ───────────────────────────────────────────────

	/**
	 * Renew an existing subscription lease without rotating the fence token.
	 * Distinct from claimSubscription, which issues a new fence.
	 */
	async renewSubscription(options: {
		subscriptionId: string;
		partitionId: string;
		holderId: string;
		fenceToken: bigint;
		leaseTtlMs?: number;
	}): Promise<SubscriptionLease> {
		const subscriptionId = parseSubscriptionId(options.subscriptionId);
		const partitionId = parsePartitionId(options.partitionId);
		const holderId = requireNonEmpty(options.holderId, "holderId");
		const fenceToken = parseFenceToken(options.fenceToken);
		const ttl = options.leaseTtlMs ?? 30_000;
		const now = this.clock.now();
		const expiresAt = new Date(Date.parse(now) + ttl).toISOString();
		const result = this.db
			.prepare(
				`UPDATE subscription_leases
         SET expires_at = ?
         WHERE subscription_id = ? AND partition_id = ?
           AND holder_id = ? AND fence_token = ?`,
			)
			.run(expiresAt, subscriptionId, partitionId, holderId, fenceToken);
		if (result.changes !== 1) {
			throw new StaleFenceError(
				`${subscriptionId}/${partitionId}`,
				fenceToken,
				0n,
			);
		}
		return Object.freeze({
			subscriptionId,
			partitionId,
			holderId,
			fenceToken,
			expiresAt,
		});
	}

	async claimSubscription(
		options: ClaimSubscriptionOptions,
	): Promise<SubscriptionLease> {
		const subscriptionId = parseSubscriptionId(options.subscriptionId);
		const partitionId = parsePartitionId(options.partitionId);
		const holderId = requireNonEmpty(options.holderId, "holderId");
		const ttl = options.leaseTtlMs ?? 30_000;
		const now = this.clock.now();
		const nowMs = Date.parse(now);
		const expiresAt = new Date(nowMs + ttl).toISOString();

		this.db.beginImmediate();
		try {
			const existing = this.db
				.prepare(
					`SELECT holder_id, fence_token, expires_at
           FROM subscription_leases
           WHERE subscription_id = ? AND partition_id = ?`,
				)
				.get(subscriptionId, partitionId);

			let fenceToken: bigint;
			if (existing) {
				const expires = asText(existing.expires_at, "expires_at");
				const heldBy = asText(existing.holder_id, "holder_id");
				const currentFence = asBigInt(existing.fence_token, "fence_token");
				if (Date.parse(expires) > nowMs && heldBy !== holderId) {
					throw new StaleFenceError(
						`${subscriptionId}/${partitionId}`,
						0n,
						currentFence,
					);
				}
				fenceToken = currentFence + 1n;
				this.db
					.prepare(
						`UPDATE subscription_leases
             SET holder_id = ?, fence_token = ?, expires_at = ?
             WHERE subscription_id = ? AND partition_id = ?`,
					)
					.run(holderId, fenceToken, expiresAt, subscriptionId, partitionId);
			} else {
				fenceToken = 1n;
				this.db
					.prepare(
						`INSERT INTO subscription_leases
             (subscription_id, partition_id, holder_id, fence_token, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
					)
					.run(subscriptionId, partitionId, holderId, fenceToken, expiresAt);
			}
			this.db.commit();
			return Object.freeze({
				subscriptionId,
				partitionId,
				holderId,
				// SAFETY: assertion required at this I/O or test boundary.
				fenceToken: fenceToken as FenceToken,
				expiresAt,
			});
		} catch (error) {
			try {
				this.db.rollback();
			} catch {
				// ignore
			}
			throw error;
		}
	}

	async loadCheckpoint(options: {
		subscriptionId: string;
		partitionId: string;
	}): Promise<SubscriptionCheckpoint | undefined> {
		const subscriptionId = parseSubscriptionId(options.subscriptionId);
		const partitionId = parsePartitionId(options.partitionId);
		const row = this.db
			.prepare(
				`SELECT subscription_id, partition_id, position, fence_token, updated_at
         FROM subscription_checkpoints
         WHERE subscription_id = ? AND partition_id = ?`,
			)
			.get(subscriptionId, partitionId);
		if (!row) return undefined;
		return Object.freeze({
			// SAFETY: assertion required at this I/O or test boundary.
			subscriptionId: asText(
				row.subscription_id,
				"subscription_id",
			) as SubscriptionId,
			// SAFETY: assertion required at this I/O or test boundary.
			partitionId: asText(row.partition_id, "partition_id") as PartitionId,
			// SAFETY: assertion required at this I/O or test boundary.
			position: asBigInt(row.position, "position") as EventPosition,
			// SAFETY: assertion required at this I/O or test boundary.
			fenceToken: asBigInt(row.fence_token, "fence_token") as FenceToken,
			updatedAt: asText(row.updated_at, "updated_at"),
		});
	}

	async commitCheckpoint(options: {
		subscriptionId: string;
		partitionId: string;
		position: bigint;
		fenceToken: bigint;
	}): Promise<SubscriptionCheckpoint> {
		const subscriptionId = parseSubscriptionId(options.subscriptionId);
		const partitionId = parsePartitionId(options.partitionId);
		const position = parseEventPosition(options.position);
		const fenceToken = parseFenceToken(options.fenceToken);
		const now = this.clock.now();

		this.db.beginImmediate();
		try {
			const lease = this.db
				.prepare(
					`SELECT holder_id, fence_token, expires_at
           FROM subscription_leases
           WHERE subscription_id = ? AND partition_id = ?`,
				)
				.get(subscriptionId, partitionId);
			if (!lease) {
				throw new StaleFenceError(
					`${subscriptionId}/${partitionId}`,
					fenceToken,
					0n,
				);
			}
			const storedFence = asBigInt(lease.fence_token, "fence_token");
			if (storedFence !== fenceToken) {
				throw new StaleFenceError(
					`${subscriptionId}/${partitionId}`,
					fenceToken,
					storedFence,
				);
			}
			const existing = this.db
				.prepare(
					`SELECT position FROM subscription_checkpoints
           WHERE subscription_id = ? AND partition_id = ?`,
				)
				.get(subscriptionId, partitionId);
			if (existing) {
				const current = asBigInt(existing.position, "position");
				if (position < current) {
					throw new CheckpointRegressionError(
						subscriptionId,
						partitionId,
						position,
						current,
					);
				}
			}
			this.db
				.prepare(
					`INSERT INTO subscription_checkpoints
             (subscription_id, partition_id, position, fence_token, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(subscription_id, partition_id) DO UPDATE SET
             position = excluded.position,
             fence_token = excluded.fence_token,
             updated_at = excluded.updated_at`,
				)
				.run(subscriptionId, partitionId, position, fenceToken, now);
			this.db.commit();
			return Object.freeze({
				subscriptionId,
				partitionId,
				position,
				fenceToken,
				updatedAt: now,
			});
		} catch (error) {
			try {
				this.db.rollback();
			} catch {
				// ignore
			}
			throw error;
		}
	}

	async resetCheckpoint(options: {
		subscriptionId: string;
		partitionId: string;
		position: bigint;
		administrative: true;
		holderId: string;
	}): Promise<SubscriptionCheckpoint> {
		const subscriptionId = parseSubscriptionId(options.subscriptionId);
		const partitionId = parsePartitionId(options.partitionId);
		const position = parseEventPosition(options.position);
		const now = this.clock.now();
		// Administrative reset uses fence 1 as marker; claim first in production
		// SAFETY: assertion required at this I/O or test boundary.
		const fenceToken = 1n as FenceToken;
		this.db
			.prepare(
				`INSERT INTO subscription_checkpoints
           (subscription_id, partition_id, position, fence_token, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(subscription_id, partition_id) DO UPDATE SET
           position = excluded.position,
           fence_token = excluded.fence_token,
           updated_at = excluded.updated_at`,
			)
			.run(subscriptionId, partitionId, position, fenceToken, now);
		return Object.freeze({
			subscriptionId,
			partitionId,
			position,
			fenceToken,
			updatedAt: now,
		});
	}

	// ── Queue operations ────────────────────────────────────────────────────

	enqueueMessage(input: QueueEnqueueInput): EnqueueMessageResult {
		const now = this.clock.now();
		const messageId =
			input.messageId ??
			createDeterministicId("msg", [input.queueName, input.idempotencyKey]);
		const existing = this.db
			.prepare(
				`SELECT message_id FROM queue_messages
         WHERE queue_name = ? AND idempotency_key = ?`,
			)
			.get(input.queueName, input.idempotencyKey);
		if (existing) {
			return {
				messageId: asText(existing.message_id, "message_id"),
				deduped: true,
			};
		}
		this.db
			.prepare(
				`INSERT INTO queue_messages (
          message_id, queue_name, actor_key, idempotency_key, body_codec, body,
          state, available_at, delivery_attempt
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
			)
			.run(
				messageId,
				input.queueName,
				input.actorKey ?? null,
				input.idempotencyKey,
				DEFAULT_PAYLOAD_CODEC,
				encodePayload(DEFAULT_PAYLOAD_CODEC, input.body),
				input.availableAt ?? now,
			);
		return { messageId, deduped: false };
	}

	leaseMessages(input: {
		queueName: string;
		maxMessages: number;
		visibilityTimeoutMs: number;
		leaseId: string;
		leaseFence: bigint;
		now?: string;
	}): Array<{
		messageId: string;
		queueName: string;
		idempotencyKey: string;
		body: JsonValue;
		leaseId: string;
		leaseFence: bigint;
		leaseExpiresAt: string;
		deliveryAttempt: number;
	}> {
		const now = input.now ?? this.clock.now();
		const nowMs = Date.parse(now);
		const expiresAt = new Date(nowMs + input.visibilityTimeoutMs).toISOString();
		const leased: Array<{
			messageId: string;
			queueName: string;
			idempotencyKey: string;
			body: JsonValue;
			leaseId: string;
			leaseFence: bigint;
			leaseExpiresAt: string;
			deliveryAttempt: number;
		}> = [];

		this.db.beginImmediate();
		try {
			// reclaim expired
			this.db
				.prepare(
					`UPDATE queue_messages
           SET state = 'pending', lease_id = NULL, lease_fence = NULL, lease_expires_at = NULL
           WHERE queue_name = ? AND state = 'leased' AND lease_expires_at < ?`,
				)
				.run(input.queueName, now);

			const candidates = this.db
				.prepare(
					`SELECT message_id, queue_name, idempotency_key, body_codec, body, delivery_attempt
           FROM queue_messages
           WHERE queue_name = ? AND state = 'pending' AND available_at <= ?
           ORDER BY available_at ASC, message_id ASC
           LIMIT ?`,
				)
				.all(input.queueName, now, input.maxMessages);

			for (const row of candidates) {
				const messageId = asText(row.message_id, "message_id");
				const attempt = asNumber(row.delivery_attempt, "delivery_attempt") + 1;
				this.db
					.prepare(
						`UPDATE queue_messages
             SET state = 'leased', lease_id = ?, lease_fence = ?, lease_expires_at = ?,
                 delivery_attempt = ?
             WHERE message_id = ? AND state = 'pending'`,
					)
					.run(input.leaseId, input.leaseFence, expiresAt, attempt, messageId);
				const codec = asText(row.body_codec, "body_codec");
				leased.push({
					messageId,
					queueName: asText(row.queue_name, "queue_name"),
					idempotencyKey: asText(row.idempotency_key, "idempotency_key"),
					body: jsonPayload(decodePayload(codec, asBytes(row.body, "body"))),
					leaseId: input.leaseId,
					leaseFence: input.leaseFence,
					leaseExpiresAt: expiresAt,
					deliveryAttempt: attempt,
				});
			}
			this.db.commit();
			return leased;
		} catch (error) {
			try {
				this.db.rollback();
			} catch {
				// ignore
			}
			throw error;
		}
	}

	completeMessage(
		messageId: string,
		leaseId: string,
		leaseFence: bigint,
	): boolean {
		const now = this.clock.now();
		const result = this.db
			.prepare(
				`UPDATE queue_messages
         SET state = 'completed', completed_at = ?, lease_id = NULL, lease_fence = NULL, lease_expires_at = NULL
         WHERE message_id = ? AND state = 'leased'
           AND lease_id = ? AND lease_fence = ?`,
			)
			.run(now, messageId, leaseId, leaseFence);
		return result.changes === 1;
	}

	// ── Outbox ──────────────────────────────────────────────────────────────

	claimOutbox(input: {
		limit: number;
		leaseId: string;
		leaseFence: bigint;
		visibilityTimeoutMs: number;
	}): Array<{
		outboxId: string;
		destination: string;
		idempotencyKey: string;
		payload: JsonValue;
		headers: Record<string, string>;
		leaseId: string;
		leaseFence: bigint;
	}> {
		const now = this.clock.now();
		const expiresAt = new Date(
			Date.parse(now) + input.visibilityTimeoutMs,
		).toISOString();
		const claimed: Array<{
			outboxId: string;
			destination: string;
			idempotencyKey: string;
			payload: JsonValue;
			headers: Record<string, string>;
			leaseId: string;
			leaseFence: bigint;
		}> = [];
		this.db.beginImmediate();
		try {
			this.db
				.prepare(
					`UPDATE outbox SET state = 'pending', lease_id = NULL, lease_fence = NULL, lease_expires_at = NULL
           WHERE state = 'leased' AND lease_expires_at < ?`,
				)
				.run(now);
			const rows = this.db
				.prepare(
					`SELECT outbox_id, destination, idempotency_key, payload_codec, payload,
                  headers_codec, headers, attempt_count
           FROM outbox
           WHERE state = 'pending' AND available_at <= ?
           ORDER BY available_at ASC, outbox_id ASC
           LIMIT ?`,
				)
				.all(now, input.limit);
			for (const row of rows) {
				const outboxId = asText(row.outbox_id, "outbox_id");
				this.db
					.prepare(
						`UPDATE outbox
             SET state = 'leased', lease_id = ?, lease_fence = ?, lease_expires_at = ?,
                 attempt_count = attempt_count + 1
             WHERE outbox_id = ? AND state = 'pending'`,
					)
					.run(input.leaseId, input.leaseFence, expiresAt, outboxId);
				const payload = jsonPayload(
					decodePayload(
						asText(row.payload_codec, "payload_codec"),
						asBytes(row.payload, "payload"),
					),
				);
				// SAFETY: assertion required at this I/O or test boundary.
				const headers = decodeMetadata(
					asText(row.headers_codec, "headers_codec"),
					asBytes(row.headers, "headers"),
				) as Record<string, string>;
				claimed.push({
					outboxId,
					destination: asText(row.destination, "destination"),
					idempotencyKey: asText(row.idempotency_key, "idempotency_key"),
					payload,
					headers,
					leaseId: input.leaseId,
					leaseFence: input.leaseFence,
				});
			}
			this.db.commit();
			return claimed;
		} catch (error) {
			try {
				this.db.rollback();
			} catch {
				// ignore
			}
			throw error;
		}
	}

	ackOutbox(outboxId: string, leaseId: string, leaseFence: bigint): boolean {
		const now = this.clock.now();
		const result = this.db
			.prepare(
				`UPDATE outbox
         SET state = 'acked', acknowledged_at = ?, lease_id = NULL, lease_fence = NULL, lease_expires_at = NULL
         WHERE outbox_id = ? AND state = 'leased'
           AND lease_id = ? AND lease_fence = ?`,
			)
			.run(now, outboxId, leaseId, leaseFence);
		return result.changes === 1;
	}

	// ── Timers ──────────────────────────────────────────────────────────────

	claimDueTimers(input: { limit: number; now?: string }): Array<{
		timerId: string;
		timerKind: string;
		subjectId: string;
		idempotencyKey: string;
		dueAt: string;
		payload: JsonValue;
	}> {
		const now = input.now ?? this.clock.now();
		const rows = this.db
			.prepare(
				`SELECT timer_id, timer_kind, subject_id, idempotency_key, due_at,
                payload_codec, payload
         FROM durable_timers
         WHERE fired_at IS NULL AND due_at <= ?
         ORDER BY due_at ASC, timer_id ASC
         LIMIT ?`,
			)
			.all(now, input.limit);
		return rows.map((row) => ({
			timerId: asText(row.timer_id, "timer_id"),
			timerKind: asText(row.timer_kind, "timer_kind"),
			subjectId: asText(row.subject_id, "subject_id"),
			idempotencyKey: asText(row.idempotency_key, "idempotency_key"),
			dueAt: asText(row.due_at, "due_at"),
			payload: jsonPayload(
				decodePayload(
					asText(row.payload_codec, "payload_codec"),
					asBytes(row.payload, "payload"),
				),
			),
		}));
	}

	markTimerFired(timerId: string, firedAt?: string): boolean {
		const at = firedAt ?? this.clock.now();
		const result = this.db
			.prepare(
				`UPDATE durable_timers SET fired_at = ? WHERE timer_id = ? AND fired_at IS NULL`,
			)
			.run(at, timerId);
		return result.changes === 1;
	}

	// ── Actor leases (durable) ──────────────────────────────────────────────

	acquireActorLease(input: {
		key: string;
		holderId: string;
		leaseTtlMs?: number;
	}): ActorLease {
		const now = this.clock.now();
		const nowMs = Date.parse(now);
		const ttl = input.leaseTtlMs ?? 30_000;
		const expiresAt = new Date(nowMs + ttl).toISOString();

		this.db.beginImmediate();
		try {
			const existing = this.db
				.prepare(
					`SELECT holder_id, fence_token, expires_at, released FROM actor_leases WHERE lease_key = ?`,
				)
				.get(input.key);
			let fenceToken: bigint;
			if (existing) {
				const released = asNumber(existing.released, "released") === 1;
				const exp = Date.parse(asText(existing.expires_at, "expires_at"));
				if (!released && exp > nowMs) {
					throw new StaleFenceError(
						input.key,
						0n,
						asBigInt(existing.fence_token, "fence_token"),
					);
				}
				fenceToken = asBigInt(existing.fence_token, "fence_token") + 1n;
				this.db
					.prepare(
						`UPDATE actor_leases
             SET holder_id = ?, fence_token = ?, expires_at = ?, released = 0
             WHERE lease_key = ?`,
					)
					.run(input.holderId, fenceToken, expiresAt, input.key);
			} else {
				fenceToken = 1n;
				this.db
					.prepare(
						`INSERT INTO actor_leases (lease_key, holder_id, fence_token, expires_at, released)
             VALUES (?, ?, ?, ?, 0)`,
					)
					.run(input.key, input.holderId, fenceToken, expiresAt);
			}
			this.db.commit();
			return {
				key: input.key,
				holderId: input.holderId,
				fenceToken,
				expiresAt,
			};
		} catch (error) {
			try {
				this.db.rollback();
			} catch {
				// ignore
			}
			throw error;
		}
	}

	releaseActorLease(key: string, holderId: string, fenceToken: bigint): void {
		this.db
			.prepare(
				`UPDATE actor_leases SET released = 1
         WHERE lease_key = ? AND holder_id = ? AND fence_token = ?`,
			)
			.run(key, holderId, fenceToken);
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private stageEffect(
		effect: DurableEffectInput,
		now: string,
		createdPosition: bigint,
	): DurableEffectReceipt {
		switch (effect.kind) {
			case "queue": {
				const queueInput: QueueEnqueueInput = {
					queueName: effect.queueName,
					idempotencyKey: effect.idempotencyKey,
					body: effect.body,
				};
				if (effect.availableAt !== undefined) {
					queueInput.availableAt = effect.availableAt;
				}
				if (effect.actorKey !== undefined) {
					queueInput.actorKey = effect.actorKey;
				}
				const result = this.enqueueMessage(queueInput);
				if (!result.deduped && createdPosition > 0n) {
					this.db
						.prepare(
							`UPDATE queue_messages SET created_position = ?
               WHERE message_id = ? AND created_position IS NULL`,
						)
						.run(createdPosition, result.messageId);
				}
				return {
					kind: "queue",
					id: result.messageId,
					idempotencyKey: effect.idempotencyKey,
					deduped: result.deduped,
				};
			}
			case "actor-signal": {
				const queueName = `actor:${effect.actorKey}`;
				const result = this.enqueueMessage({
					queueName,
					idempotencyKey: effect.idempotencyKey,
					body: effect.body,
					actorKey: effect.actorKey,
				});
				return {
					kind: "actor-signal",
					id: result.messageId,
					idempotencyKey: effect.idempotencyKey,
					deduped: result.deduped,
				};
			}
			case "timer": {
				const timerId =
					effect.timerId ??
					createDeterministicId("timer", [
						effect.subjectId,
						effect.idempotencyKey,
					]);
				const existing = this.db
					.prepare(
						`SELECT timer_id FROM durable_timers
             WHERE subject_id = ? AND idempotency_key = ?`,
					)
					.get(effect.subjectId, effect.idempotencyKey);
				if (existing) {
					return {
						kind: "timer",
						id: asText(existing.timer_id, "timer_id"),
						idempotencyKey: effect.idempotencyKey,
						deduped: true,
					};
				}
				this.db
					.prepare(
						`INSERT INTO durable_timers (
              timer_id, timer_kind, subject_id, idempotency_key, due_at,
              occurrence, payload_codec, payload, created_position
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
					)
					.run(
						timerId,
						effect.timerKind,
						effect.subjectId,
						effect.idempotencyKey,
						effect.dueAt,
						DEFAULT_PAYLOAD_CODEC,
						encodePayload(DEFAULT_PAYLOAD_CODEC, effect.payload ?? {}),
						createdPosition > 0n ? createdPosition : null,
					);
				return {
					kind: "timer",
					id: timerId,
					idempotencyKey: effect.idempotencyKey,
					deduped: false,
				};
			}
			case "cron": {
				const existing = this.db
					.prepare(
						`SELECT schedule_id FROM cron_schedules WHERE schedule_id = ?`,
					)
					.get(effect.scheduleId);
				if (existing) {
					this.db
						.prepare(
							`UPDATE cron_schedules
               SET every_ms = ?, start_at = ?, next_fire_at = ?, occurrence = ?, updated_at = ?
               WHERE schedule_id = ?`,
						)
						.run(
							effect.everyMs,
							effect.startAt,
							effect.nextFireAt,
							effect.occurrence ?? 0,
							now,
							effect.scheduleId,
						);
					return {
						kind: "cron",
						id: effect.scheduleId,
						idempotencyKey: effect.scheduleId,
						deduped: true,
					};
				}
				this.db
					.prepare(
						`INSERT INTO cron_schedules
             (schedule_id, every_ms, start_at, next_fire_at, occurrence, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.run(
						effect.scheduleId,
						effect.everyMs,
						effect.startAt,
						effect.nextFireAt,
						effect.occurrence ?? 0,
						now,
					);
				return {
					kind: "cron",
					id: effect.scheduleId,
					idempotencyKey: effect.scheduleId,
					deduped: false,
				};
			}
			case "outbox": {
				const outboxId = createDeterministicId("outbox", [
					effect.destination,
					effect.idempotencyKey,
				]);
				const existing = this.db
					.prepare(
						`SELECT outbox_id FROM outbox
             WHERE destination = ? AND idempotency_key = ?`,
					)
					.get(effect.destination, effect.idempotencyKey);
				if (existing) {
					return {
						kind: "outbox",
						id: asText(existing.outbox_id, "outbox_id"),
						idempotencyKey: effect.idempotencyKey,
						deduped: true,
					};
				}
				this.db
					.prepare(
						`INSERT INTO outbox (
              outbox_id, destination, idempotency_key, payload_codec, payload,
              headers_codec, headers, state, available_at, attempt_count, created_position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)`,
					)
					.run(
						outboxId,
						effect.destination,
						effect.idempotencyKey,
						DEFAULT_PAYLOAD_CODEC,
						encodePayload(DEFAULT_PAYLOAD_CODEC, effect.payload),
						DEFAULT_METADATA_CODEC,
						encodeMetadata(
							DEFAULT_METADATA_CODEC,
							asJsonObject(effect.headers ?? {}),
						),
						effect.availableAt ?? now,
						createdPosition > 0n ? createdPosition : null,
					);
				return {
					kind: "outbox",
					id: outboxId,
					idempotencyKey: effect.idempotencyKey,
					deduped: false,
				};
			}
			default: {
				const _exhaustive: never = effect;
				throw new TypeError(
					`unknown effect kind: ${JSON.stringify(_exhaustive)}`,
				);
			}
		}
	}

	private findByIdempotencyKey(
		streamId: string,
		idempotencyKey: string,
	): EventEnvelope | undefined {
		const row = this.db
			.prepare(
				`SELECT global_position, stream_id, seq, id, type, v, ts, actor, tenant,
                project, causation_id, correlation_id, lane, payload_codec, data,
                metadata_codec, meta
         FROM events
         WHERE stream_id = ? AND idempotency_key = ?`,
			)
			.get(streamId, idempotencyKey);
		return row ? this.rowToEnvelope(row) : undefined;
	}

	private rowToEnvelope(row: SqliteRow): EventEnvelope {
		const payloadCodec = asText(row.payload_codec, "payload_codec");
		const metadataCodec = asText(row.metadata_codec, "metadata_codec");
		const actor = decodeJson(asBytes(row.actor, "actor"));
		const data = jsonPayload(
			decodePayload(payloadCodec, asBytes(row.data, "data")),
		);
		const meta = decodeMetadata(metadataCodec, asBytes(row.meta, "meta"));
		return parseEventEnvelope({
			id: asText(row.id, "id"),
			type: asText(row.type, "type"),
			v: asNumber(row.v, "v"),
			streamId: asText(row.stream_id, "stream_id"),
			seq: asNumber(row.seq, "seq"),
			ts: asText(row.ts, "ts"),
			actor,
			tenant: asText(row.tenant, "tenant"),
			project:
				row.project === null || row.project === undefined
					? undefined
					: asText(row.project, "project"),
			causationId:
				row.causation_id === null || row.causation_id === undefined
					? undefined
					: asText(row.causation_id, "causation_id"),
			correlationId:
				row.correlation_id === null || row.correlation_id === undefined
					? undefined
					: asText(row.correlation_id, "correlation_id"),
			lane:
				row.lane === null || row.lane === undefined
					? undefined
					: asText(row.lane, "lane"),
			data,
			meta,
		});
	}

	private createEnvelope(
		input: ParsedEventInput,
		seq: number,
		streamId: string,
		opts: AppendOptions,
	): EventEnvelope {
		const meta = { ...input.meta };
		if (input.idempotencyKey && meta.idempotencyKey === undefined) {
			meta.idempotencyKey = input.idempotencyKey;
		}
		return parseEventEnvelope({
			id: this.nextUlid(),
			streamId,
			seq,
			type: input.type,
			v: input.v,
			ts: this.clock.now(),
			actor: opts.actor,
			tenant: opts.tenant,
			project: opts.project,
			causationId: opts.causationId,
			correlationId: opts.correlationId,
			lane: opts.lane,
			data: cloneJson(input.data),
			meta: cloneJson(meta),
		});
	}

	private publish(envelope: EventEnvelope): void {
		for (const sub of this.liveHandlers) {
			if (matches(sub.filter, envelope)) {
				void sub.handler(cloneJson(envelope));
			}
		}
	}
}

function matches(filter: StreamFilter, envelope: EventEnvelope): boolean {
	return (
		(!filter.streamId || filter.streamId === envelope.streamId) &&
		(!filter.type || filter.type === envelope.type)
	);
}

function parseEventInputs(events: readonly EventInput[]): ParsedEventInput[] {
	if (!Array.isArray(events)) {
		throw new TypeError("events must be an array");
	}
	return events.map((event) => {
		if (!event || !isJsonObject(event)) {
			throw new TypeError("event must be an object");
		}
		const type = requireNonEmpty(event.type, "event.type");
		const v = event.v ?? 1;
		if (!Number.isSafeInteger(v) || v <= 0) {
			throw new TypeError("event.v must be a positive safe integer");
		}
		// SAFETY: assertion required at this I/O or test boundary.
		const meta = Object.freeze(cloneJson(event.meta ?? {})) as JsonObject;
		const idempotencyKey =
			isJsonString(meta.idempotencyKey) && meta.idempotencyKey.length > 0
				? meta.idempotencyKey
				: undefined;
		return Object.freeze({
			type,
			v,
			data: cloneJson(event.data ?? {}),
			meta,
			idempotencyKey,
		});
	});
}

function jsonPayload(value: DecodedPayload): JsonValue {
	return value instanceof Uint8Array ? null : value;
}

function requireNonEmpty(value: JsonValue, field: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${field} must be a non-empty string`);
	}
	return value;
}

function requireNonNegInt<T>(value: T, field: string): number {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${field} must be a non-negative safe integer`);
	}
	return value;
}

function cloneJson<T>(value: T): T {
	if (value === undefined) return value;
	if (globalThis.structuredClone instanceof Function) {
		return globalThis.structuredClone(value);
	}
	const text = JSON.stringify(value);
	// SAFETY: JSON round-trip clones a JSON-serializable domain value.
	const cloned = JSON.parse(text) as T;
	return cloned;
}

import { performance } from "node:perf_hooks";
import {
	type AppendOptions,
	type AppendResult,
	type ClaimSubscriptionOptions,
	type Clock,
	type CommitCheckpointOptions,
	type DurableCommitRequest,
	type DurableCommitResult,
	type DurableEffectReceipt,
	type DurableEventStore,
	EVENTSTORE_LIMITS,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	EventStoreError,
	FENCING_COMPAT,
	type FoldHandlers,
	type FoldResult,
	MissingFenceError,
	OptimisticSequenceConflictError,
	type PositionedEvent,
	parseEventEnvelope,
	parseEventPosition,
	type ReadAllOptions,
	type ResetCheckpointOptions,
	SnapshotAheadError,
	type SnapshotRecord,
	StaleFenceError,
	type StreamFilter,
	type StreamHead,
	type Subscription,
	type SubscriptionCheckpoint,
	type SubscriptionLease,
} from "@hobo/core";
import {
	type PostgresStoreConfig,
	type PostgresStoreConfigInput,
	parsePostgresStoreConfig,
} from "./config.js";
import { stageEffect } from "./effects.js";
import {
	isRetryableTransactionError,
	StoragePostgresError,
	translatePgError,
} from "./errors.js";
import { notifyChannel, quoteSchema, type SchemaName } from "./identifiers.js";
import { eventIdFor } from "./ids.js";
import { type MigrationReport, migrateSchema } from "./migrate.js";
import { SCHEMA_VERSION } from "./migrations/index.js";
import {
	type ParsedAppend,
	type ParsedEventInput,
	parseAppendOptions,
	parseEventInputs,
	parseLeaseTtl,
	requireNonEmpty,
	requireNonNegInt,
} from "./parse.js";
import {
	createPgListener,
	createPgPool,
	int4,
	int8,
	type PgClientLike,
	type PgListenerLike,
	type PgPoolLike,
	type PgRow,
} from "./pg.js";
import {
	decodeJsonColumn,
	EVENT_COLUMNS,
	JSON_CODEC,
	rowToEnvelope,
} from "./rows.js";
import {
	type CheckpointLogEntry,
	claimLease,
	commitCheckpoint,
	loadCheckpoint,
	parseLeaseKey,
	readCheckpointLog,
	releaseLease,
	renewLease,
	resetCheckpoint,
} from "./subscriptions.js";
import {
	createStoreMetrics,
	STORAGE_POSTGRES_METRICS as M,
	type StoreTelemetrySink,
} from "./telemetry.js";

export type PostgresEventStoreOptions = Readonly<{
	config: PostgresStoreConfigInput;
	/** Share an existing pool; the caller owns its lifecycle (`end()` leaves it open). */
	pool?: PgPoolLike;
	/** Factory for the dedicated LISTEN connection used by `subscribe`. */
	listener?: () => PgListenerLike;
	/** Injected clock (I8). Every stored timestamp and lease expiry comes from it. */
	clock?: Clock;
	telemetry?: StoreTelemetrySink;
	/** Monotonic milliseconds for durations only; never used in decisions. */
	monotonicMs?: () => number;
}>;

export type StoreHealth = Readonly<{
	ok: boolean;
	checks: readonly Readonly<{ name: string; ok: boolean; detail: string }>[];
}>;

/** The PostgreSQL DurableEventStore. Every optional port method is present. */
export interface PostgresEventStore extends DurableEventStore {
	readonly schema: SchemaName;
	readonly partitionId: string;
	readonly config: PostgresStoreConfig;
	/** Connect and migrate (also done lazily by the first operation). */
	ready(): Promise<MigrationReport>;
	fold<S>(
		streamId: string,
		opts: { initialState: S; handlers: FoldHandlers<S> },
	): Promise<FoldResult<S>>;
	loadSnapshot<S>(streamId: string): Promise<SnapshotRecord<S> | undefined>;
	/** Asynchronous stream head (the port's synchronous `getStreamHead` cannot reach a server). */
	loadStreamHead(streamId: string): Promise<StreamHead | undefined>;
	claimSubscription(
		options: ClaimSubscriptionOptions,
	): Promise<SubscriptionLease>;
	renewSubscription(
		options: ClaimSubscriptionOptions & { fenceToken: bigint },
	): Promise<SubscriptionLease>;
	releaseSubscription(options: {
		subscriptionId: string;
		partitionId: string;
		holderId: string;
		fenceToken: bigint;
	}): Promise<void>;
	loadCheckpoint(options: {
		subscriptionId: string;
		partitionId: string;
	}): Promise<SubscriptionCheckpoint | undefined>;
	commitCheckpoint(
		options: CommitCheckpointOptions,
	): Promise<SubscriptionCheckpoint>;
	resetCheckpoint(
		options: ResetCheckpointOptions,
	): Promise<SubscriptionCheckpoint>;
	/** Audit log of every checkpoint movement for one subscription partition. */
	checkpointLog(options: {
		subscriptionId: string;
		partitionId: string;
	}): Promise<readonly CheckpointLogEntry[]>;
	health(): Promise<StoreHealth>;
	/** Wait for pending metric emissions. */
	flushTelemetry(): Promise<void>;
	/** Close without waiting (conformance factories need a synchronous close). */
	close(): void;
	/** Close and wait for the pool and listener to end. */
	end(): Promise<void>;
}

const MAX_TX_ATTEMPTS = 3;
const READ_PAGE = EVENTSTORE_LIMITS.maxReadPage;

type LiveSub = {
	readonly filter: StreamFilter;
	readonly handler: (event: EventEnvelope) => void | Promise<void>;
};

function systemClock(): Clock {
	return { now: () => new Date().toISOString() };
}

function matches(filter: StreamFilter, event: EventEnvelope): boolean {
	return (
		(!filter.streamId || filter.streamId === event.streamId) &&
		(!filter.type || filter.type === event.type)
	);
}

function asPosition(value: bigint): EventPosition {
	return parseEventPosition(value);
}

function cloneJson<T>(value: T): T {
	return structuredClone(value);
}

function isError(value: unknown): value is Error {
	return value instanceof Error;
}

function asError(value: unknown): Error {
	return isError(value) ? value : new Error(String(value));
}

/**
 * Create a PostgreSQL-backed DurableEventStore.
 *
 * Creation is synchronous; connecting and migrating happen on the first
 * operation (or `ready()`), so the store drops into factories that must
 * return synchronously.
 */
export function createPostgresEventStore(
	options: PostgresEventStoreOptions,
): PostgresEventStore {
	const config = parsePostgresStoreConfig(options.config);
	if (options.pool === undefined && config.connectionString === "") {
		throw new StoragePostgresError(
			"invalid-config",
			"connectionString is required unless a pool is injected",
		);
	}
	const ownsPool = options.pool === undefined;
	const pool = options.pool ?? createPgPool(config);
	const listenerFactory = options.listener ?? (() => createPgListener(config));
	const clock = options.clock ?? systemClock();
	const monotonic = options.monotonicMs ?? (() => performance.now());
	const s = quoteSchema(config.schema);
	const metrics = createStoreMetrics(
		options.telemetry,
		() => {
			const ms = Date.parse(clock.now());
			return Number.isFinite(ms) ? ms : 0;
		},
		{
			"db.system": "postgresql",
			"hobo.storage.schema": config.schema,
			"hobo.storage.partition": config.partitionId,
		},
	);

	let closed = false;
	let readyPromise: Promise<MigrationReport> | undefined;
	let ending: Promise<void> | undefined;

	function countError(error: Error): void {
		const failure =
			error instanceof StoragePostgresError
				? error.failure
				: error instanceof EventStoreError
					? error.code
					: "unexpected";
		metrics.emit([
			{
				name: M.errors,
				kind: "counter",
				value: 1,
				unit: "{error}",
				attributes: { failure },
			},
		]);
	}

	async function connect(): Promise<PgClientLike> {
		if (closed) {
			throw new StoragePostgresError(
				"closed",
				`store ${config.schema} is closed`,
			);
		}
		try {
			return await pool.connect();
		} catch (error) {
			const translated = translatePgError(asError(error));
			if (translated instanceof StoragePostgresError) throw translated;
			throw new StoragePostgresError("unavailable", translated.message, {
				cause: translated,
			});
		}
	}

	async function initialize(): Promise<MigrationReport> {
		const client = await connect();
		try {
			const report = await migrateSchema(client, {
				schema: config.schema,
				minServerMajorVersion: config.minServerMajorVersion,
				now: clock.now(),
			});
			if (report.applied.length > 0) {
				metrics.emit([
					{
						name: M.migrationsApplied,
						kind: "counter",
						value: report.applied.length,
						unit: "{migration}",
						attributes: { to_version: report.toVersion },
					},
				]);
			}
			client.release();
			return report;
		} catch (error) {
			client.release(true);
			throw translatePgError(asError(error));
		}
	}

	function ready(): Promise<MigrationReport> {
		if (readyPromise === undefined) {
			const attempt = initialize();
			readyPromise = attempt;
			attempt.catch((error: unknown) => {
				countError(asError(error));
				// Retry only transient failures; drift, schema-ahead and old
				// servers stay refused for the life of this store.
				if (
					error instanceof StoragePostgresError &&
					(error.failure === "unavailable" ||
						error.failure === "statement-timeout")
				) {
					readyPromise = undefined;
				}
			});
		}
		return readyPromise;
	}

	/** Run `fn` in one READ COMMITTED transaction; retry serialization/deadlock aborts. */
	async function tx<T>(fn: (client: PgClientLike) => Promise<T>): Promise<T> {
		await ready();
		for (let attempt = 1; ; attempt += 1) {
			const client = await connect();
			let broken = false;
			try {
				await client.query("BEGIN");
				const result = await fn(client);
				await client.query("COMMIT");
				return result;
			} catch (caught) {
				const error = asError(caught);
				try {
					await client.query("ROLLBACK");
				} catch {
					broken = true;
				}
				if (isRetryableTransactionError(error) && attempt < MAX_TX_ATTEMPTS) {
					metrics.emit([
						{
							name: M.retries,
							kind: "counter",
							value: 1,
							unit: "{retry}",
							attributes: {},
						},
					]);
					continue;
				}
				const translated = translatePgError(error);
				if (
					translated instanceof StoragePostgresError &&
					translated.failure === "unavailable"
				) {
					broken = true;
				}
				throw translated;
			} finally {
				client.release(broken);
			}
		}
	}

	/** Run a read-only statement outside a transaction. */
	async function read<T>(fn: (client: PgClientLike) => Promise<T>): Promise<T> {
		await ready();
		const client = await connect();
		let broken = false;
		try {
			return await fn(client);
		} catch (caught) {
			const translated = translatePgError(asError(caught));
			if (
				translated instanceof StoragePostgresError &&
				translated.failure === "unavailable"
			) {
				broken = true;
			}
			throw translated;
		} finally {
			client.release(broken);
		}
	}

	// ── live wake (in-process handlers fed in position order) ──────────────

	const live = new Set<LiveSub>();
	let liveCursor: bigint | undefined;
	let liveStart: Promise<void> | undefined;
	const earlyLocalFirsts: bigint[] = [];
	let listener: PgListenerLike | undefined;
	let listening: Promise<void> | undefined;
	let pumping: Promise<void> | undefined;
	let pumpAgain = false;

	async function headPosition(): Promise<bigint> {
		return read(async (client) => {
			const result = await client.query(
				`SELECT last_position FROM ${s}.partition_head WHERE id = 1`,
			);
			const row = result.rows[0];
			return row === undefined ? 0n : int8(row, "last_position");
		});
	}

	function startListener(): Promise<void> {
		if (listening !== undefined) return listening;
		const client = listenerFactory();
		listener = client;
		listening = (async () => {
			client.onError((error: Error) => {
				countError(translatePgError(error));
				if (listener === client) {
					listener = undefined;
					listening = undefined;
				}
			});
			client.onNotification((channel) => {
				if (channel === notifyChannel(config.schema)) schedulePump();
			});
			await client.connect();
			await client.query(`LISTEN "${notifyChannel(config.schema)}"`);
		})();
		listening.catch((error: unknown) => {
			countError(translatePgError(asError(error)));
			if (listener === client) {
				listener = undefined;
				listening = undefined;
			}
			void client.end().catch(() => undefined);
		});
		return listening;
	}

	async function stopListener(): Promise<void> {
		const client = listener;
		listener = undefined;
		listening = undefined;
		if (client !== undefined) await client.end().catch(() => undefined);
	}

	function startLive(): void {
		liveStart = (async () => {
			const head = await headPosition();
			const earliest = earlyLocalFirsts.reduce<bigint | undefined>(
				(min, first) =>
					min === undefined || first - 1n < min ? first - 1n : min,
				undefined,
			);
			earlyLocalFirsts.length = 0;
			liveCursor = earliest !== undefined && earliest < head ? earliest : head;
			await startListener().catch(() => undefined);
		})();
		liveStart.catch((error: unknown) => countError(asError(error)));
	}

	async function pumpOnce(): Promise<void> {
		if (liveStart !== undefined) await liveStart;
		if (live.size === 0 || liveCursor === undefined) return;
		if (listener === undefined && !closed)
			void startListener().catch(() => undefined);
		for (;;) {
			const page: PositionedEvent[] = [];
			for await (const item of readAllPage({ after: asPosition(liveCursor) }))
				page.push(item);
			if (page.length === 0) return;
			for (const { position, event } of page) {
				liveCursor = position;
				for (const sub of live) {
					if (!matches(sub.filter, event)) continue;
					try {
						const outcome = sub.handler(cloneJson(event));
						if (outcome instanceof Promise) outcome.catch(() => undefined);
					} catch {
						// A failing live handler never fails the store or other handlers.
					}
				}
			}
		}
	}

	function schedulePump(): void {
		if (live.size === 0 || closed) return;
		if (pumping !== undefined) {
			pumpAgain = true;
			return;
		}
		pumping = (async () => {
			try {
				do {
					pumpAgain = false;
					await pumpOnce();
				} while (pumpAgain && live.size > 0 && !closed);
			} catch (error) {
				countError(asError(error));
			} finally {
				pumping = undefined;
			}
		})();
	}

	// ── reads ──────────────────────────────────────────────────────────────

	function readAllPage(
		options: ReadAllOptions = {},
	): AsyncIterable<PositionedEvent> {
		const after =
			options.after === undefined
				? 0n
				: parseEventPosition(options.after, "after");
		const limit = Math.min(options.limit ?? READ_PAGE, READ_PAGE);
		if (!Number.isSafeInteger(limit) || limit < 0) {
			throw new StoragePostgresError(
				"invalid-input",
				"limit must be a non-negative integer",
			);
		}
		const params: (string | number)[] = [after.toString()];
		const clauses = ["global_position > $1"];
		if (options.filter?.streamId) {
			params.push(options.filter.streamId);
			clauses.push(`stream_id = $${params.length}`);
		}
		if (options.filter?.type) {
			params.push(options.filter.type);
			clauses.push(`type = $${params.length}`);
		}
		if (options.tenant) {
			params.push(options.tenant);
			clauses.push(`tenant = $${params.length}`);
		}
		if (options.lane) {
			params.push(options.lane);
			clauses.push(`lane = $${params.length}`);
		}
		params.push(limit);
		const sql = `SELECT ${EVENT_COLUMNS} FROM ${s}.events
       WHERE ${clauses.join(" AND ")}
       ORDER BY global_position ASC LIMIT $${params.length}`;
		return {
			async *[Symbol.asyncIterator]() {
				const rows = await read((client) => client.query(sql, params));
				for (const row of rows.rows) {
					yield Object.freeze({
						position: asPosition(int8(row, "global_position")),
						event: rowToEnvelope(row),
					});
				}
			},
		};
	}

	async function* readStream(
		streamId: string,
		fromSeq: number,
	): AsyncIterable<EventEnvelope> {
		const id = requireNonEmpty(streamId, "streamId");
		let next = requireNonNegInt(fromSeq, "fromSeq");
		for (;;) {
			const result = await read((client) =>
				client.query(
					`SELECT ${EVENT_COLUMNS} FROM ${s}.events
           WHERE stream_id = $1 AND seq >= $2 ORDER BY seq ASC LIMIT $3`,
					[id, next, READ_PAGE],
				),
			);
			for (const row of result.rows) {
				const event = rowToEnvelope(row);
				next = event.seq + 1;
				yield event;
			}
			if (result.rows.length < READ_PAGE) return;
		}
	}

	async function loadStreamHead(
		streamId: string,
	): Promise<StreamHead | undefined> {
		const id = requireNonEmpty(streamId, "streamId");
		return read(async (client) => {
			const result = await client.query(
				`SELECT revision, owner_epoch FROM ${s}.streams WHERE stream_id = $1`,
				[id],
			);
			const row = result.rows[0];
			if (row === undefined) return undefined;
			return Object.freeze({
				streamId: id,
				revision: int4(row, "revision"),
				ownerEpoch: int8(row, "owner_epoch"),
			});
		});
	}

	// ── commit ─────────────────────────────────────────────────────────────

	function nextOwnerEpoch(
		streamId: string,
		stored: bigint,
		fence: bigint | undefined,
	): bigint {
		if (stored > FENCING_COMPAT.UNFENCED_EPOCH) {
			if (fence === undefined) throw new MissingFenceError(streamId, stored);
			if (fence < stored) throw new StaleFenceError(streamId, fence, stored);
			return fence;
		}
		return fence !== undefined && fence > 0n ? fence : stored;
	}

	function envelopeFor(
		input: ParsedEventInput,
		append: ParsedAppend,
		streamId: string,
		seq: number,
		position: bigint,
		ts: string,
	): EventEnvelope {
		const meta = { ...input.meta };
		if (
			input.idempotencyKey !== undefined &&
			meta.idempotencyKey === undefined
		) {
			meta.idempotencyKey = input.idempotencyKey;
		}
		const tsMs = Date.parse(ts);
		return parseEventEnvelope({
			id: eventIdFor(Number.isFinite(tsMs) && tsMs >= 0 ? tsMs : 0, position),
			streamId,
			seq,
			type: input.type,
			v: input.v,
			ts,
			actor: append.actor,
			tenant: append.tenant,
			project: append.project,
			causationId: append.causationId,
			correlationId: append.correlationId,
			lane: append.lane,
			data: input.data,
			meta,
		});
	}

	async function commitIn(
		client: PgClientLike,
		streamId: string,
		inputs: readonly ParsedEventInput[],
		append: ParsedAppend,
		effects: DurableCommitRequest["effects"],
	): Promise<DurableCommitResult & { lastPositionRaw: bigint | undefined }> {
		const now = clock.now();
		await client.query(
			`INSERT INTO ${s}.streams (stream_id, revision, owner_epoch, created_at, updated_at)
       VALUES ($1, 0, 0, $2, $2) ON CONFLICT (stream_id) DO NOTHING`,
			[streamId, now],
		);
		const head = await client.query(
			`SELECT revision, owner_epoch FROM ${s}.streams WHERE stream_id = $1 FOR UPDATE`,
			[streamId],
		);
		const headRow = head.rows[0];
		if (headRow === undefined) {
			throw new EventStoreError(
				"INTEGRITY_FAILURE",
				`stream head missing for ${streamId}`,
			);
		}
		const revision = int4(headRow, "revision");
		const ownerEpoch = int8(headRow, "owner_epoch");

		const keys = inputs.flatMap((input) =>
			input.idempotencyKey === undefined ? [] : [input.idempotencyKey],
		);
		const committed = new Map<string, EventEnvelope>();
		if (keys.length > 0) {
			const found = await client.query(
				`SELECT ${EVENT_COLUMNS}, idempotency_key FROM ${s}.events
         WHERE stream_id = $1 AND idempotency_key = ANY($2::text[])`,
				[streamId, keys],
			);
			for (const row of found.rows) {
				const key = row.idempotency_key;
				if (typeof key === "string") committed.set(key, rowToEnvelope(row));
			}
		}
		const deduped: EventEnvelope[] = [];
		const toWrite: ParsedEventInput[] = [];
		const batchKeys = new Set<string>();
		const duplicateKeys: string[] = [];
		for (const input of inputs) {
			const key = input.idempotencyKey;
			if (key !== undefined) {
				const prior = committed.get(key);
				if (prior !== undefined) {
					deduped.push(prior);
					continue;
				}
				if (batchKeys.has(key)) {
					duplicateKeys.push(key);
					continue;
				}
				batchKeys.add(key);
			}
			toWrite.push(input);
		}
		const effectList = effects ?? [];
		if (toWrite.length === 0 && effectList.length === 0) {
			return Object.freeze({
				streamId,
				appended: [],
				deduped,
				effects: [],
				lastPositionRaw: undefined,
			});
		}

		const epoch = nextOwnerEpoch(streamId, ownerEpoch, append.fenceToken);
		if (toWrite.length > 0 && append.expectedSeq !== revision) {
			throw new OptimisticSequenceConflictError(
				streamId,
				append.expectedSeq,
				revision,
			);
		}

		// Position allocation: the partition-head row lock is taken last and
		// held to commit, so positions are gapless and visible in order.
		const allocated = await client.query(
			`UPDATE ${s}.partition_head SET last_position = last_position + $1
       WHERE id = 1 RETURNING last_position`,
			[toWrite.length],
		);
		const allocatedRow = allocated.rows[0];
		if (allocatedRow === undefined) {
			throw new EventStoreError(
				"INTEGRITY_FAILURE",
				"partition head row missing",
			);
		}
		const lastAllocated = int8(allocatedRow, "last_position");
		const firstAllocated = lastAllocated - BigInt(toWrite.length) + 1n;

		const appended: EventEnvelope[] = [];
		for (const [index, input] of toWrite.entries()) {
			const position = firstAllocated + BigInt(index);
			const envelope = envelopeFor(
				input,
				append,
				streamId,
				revision + index + 1,
				position,
				now,
			);
			await client.query(
				`INSERT INTO ${s}.events (
           global_position, stream_id, seq, id, type, v, ts, actor, tenant, project,
           causation_id, correlation_id, lane, payload_codec, data, metadata_codec,
           meta, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
				[
					position.toString(),
					streamId,
					envelope.seq,
					envelope.id,
					envelope.type,
					envelope.v,
					envelope.ts,
					JSON.stringify(envelope.actor),
					envelope.tenant,
					envelope.project ?? null,
					envelope.causationId ?? null,
					envelope.correlationId ?? null,
					envelope.lane ?? null,
					JSON_CODEC,
					JSON.stringify(envelope.data),
					JSON_CODEC,
					JSON.stringify(envelope.meta ?? {}),
					input.idempotencyKey ?? null,
				],
			);
			appended.push(envelope);
		}
		if (toWrite.length > 0 || epoch !== ownerEpoch) {
			await client.query(
				`UPDATE ${s}.streams SET revision = $2, owner_epoch = $3, updated_at = $4
         WHERE stream_id = $1`,
				[streamId, revision + toWrite.length, epoch.toString(), now],
			);
		}

		const lastPosition = toWrite.length > 0 ? lastAllocated : undefined;
		const receipts: DurableEffectReceipt[] = [];
		for (const effect of effectList) {
			receipts.push(
				await stageEffect(client, s, effect, now, lastPosition ?? 0n),
			);
		}
		for (const key of duplicateKeys) {
			const envelope = appended.find(
				(item) => item.meta?.idempotencyKey === key,
			);
			if (envelope !== undefined) deduped.push(envelope);
		}
		if (lastPosition !== undefined) {
			await client.query("SELECT pg_notify($1, $2)", [
				notifyChannel(config.schema),
				lastPosition.toString(),
			]);
		}
		return Object.freeze({
			streamId,
			appended,
			deduped,
			effects: Object.freeze(receipts),
			lastPositionRaw: lastPosition,
			...(lastPosition !== undefined
				? {
						firstPosition: asPosition(firstAllocated),
						lastPosition: asPosition(lastPosition),
					}
				: undefined),
		});
	}

	function conflictCode(error: Error): string | undefined {
		if (error instanceof EventStoreError) {
			switch (error.code) {
				case "OPTIMISTIC_SEQUENCE_CONFLICT":
				case "STALE_FENCE":
				case "MISSING_FENCE":
				case "CHECKPOINT_REGRESSION":
				case "SUBSCRIPTION_LEASE_CONFLICT":
					return error.code;
				default:
					return undefined;
			}
		}
		return undefined;
	}

	/** Measure an operation; count conflicts and errors by code. */
	async function measured<T>(
		operation: string,
		fn: () => Promise<T>,
		onSuccess?: (value: T) => void,
	): Promise<T> {
		const started = monotonic();
		try {
			const value = await fn();
			metrics.emit([
				{
					name: M.commitDuration,
					kind: "histogram",
					value: monotonic() - started,
					unit: "ms",
					attributes: { operation, outcome: "ok" },
				},
			]);
			onSuccess?.(value);
			return value;
		} catch (caught) {
			const error = asError(caught);
			const conflict = conflictCode(error);
			metrics.emit([
				{
					name: M.commitDuration,
					kind: "histogram",
					value: monotonic() - started,
					unit: "ms",
					attributes: {
						operation,
						outcome: conflict === undefined ? "error" : "conflict",
					},
				},
				conflict === undefined
					? {
							name: M.errors,
							kind: "counter",
							value: 1,
							unit: "{error}",
							attributes: {
								failure:
									error instanceof StoragePostgresError
										? error.failure
										: error instanceof EventStoreError
											? error.code
											: "unexpected",
								operation,
							},
						}
					: {
							name: M.conflicts,
							kind: "counter",
							value: 1,
							unit: "{conflict}",
							attributes: { code: conflict, operation },
						},
			]);
			throw error;
		}
	}

	async function commit(
		request: DurableCommitRequest,
	): Promise<DurableCommitResult> {
		const streamId = requireNonEmpty(request.streamId, "streamId");
		const inputs = parseEventInputs(request.events);
		const append = parseAppendOptions(request.append);
		const effects = request.effects ?? [];
		if (!Array.isArray(effects)) {
			throw new StoragePostgresError(
				"invalid-input",
				"effects must be an array",
			);
		}
		const result = await measured(
			"commit",
			() => tx((client) => commitIn(client, streamId, inputs, append, effects)),
			(value) => {
				if (value.appended.length > 0) {
					metrics.emit([
						{
							name: M.eventsAppended,
							kind: "counter",
							value: value.appended.length,
							unit: "{event}",
							attributes: {},
						},
					]);
				}
			},
		);
		if (result.firstPosition !== undefined) {
			if (liveCursor === undefined && liveStart !== undefined) {
				earlyLocalFirsts.push(result.firstPosition);
			}
			schedulePump();
		}
		const { lastPositionRaw: _omit, ...rest } = result;
		return Object.freeze({
			...rest,
			appended: cloneJson(rest.appended),
			deduped: cloneJson(rest.deduped),
		});
	}

	// ── snapshots and fold ─────────────────────────────────────────────────

	async function snapshot(
		streamId: string,
		state: unknown,
		seq: number,
	): Promise<SnapshotRecord> {
		const id = requireNonEmpty(streamId, "streamId");
		const snapshotSeq = requireNonNegInt(seq, "seq");
		let stateText: string | undefined;
		try {
			stateText = JSON.stringify(state ?? null);
		} catch {
			stateText = undefined;
		}
		if (stateText === undefined) {
			throw new StoragePostgresError(
				"invalid-input",
				"snapshot state must be JSON-serialisable",
			);
		}
		const savedAt = clock.now();
		const encoded = stateText;
		await tx(async (client) => {
			await client.query(
				`INSERT INTO ${s}.streams (stream_id, revision, owner_epoch, created_at, updated_at)
         VALUES ($1, 0, 0, $2, $2) ON CONFLICT (stream_id) DO NOTHING`,
				[id, savedAt],
			);
			const head = await client.query(
				`SELECT revision FROM ${s}.streams WHERE stream_id = $1 FOR SHARE`,
				[id],
			);
			const headSeq =
				head.rows[0] === undefined ? 0 : int4(head.rows[0], "revision");
			if (snapshotSeq > headSeq)
				throw new SnapshotAheadError(id, snapshotSeq, headSeq);
			await client.query(
				`INSERT INTO ${s}.snapshots (stream_id, seq, state_codec, state, saved_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (stream_id, seq) DO UPDATE SET
           state_codec = EXCLUDED.state_codec, state = EXCLUDED.state, saved_at = EXCLUDED.saved_at`,
				[id, snapshotSeq, JSON_CODEC, encoded, savedAt],
			);
		});
		return Object.freeze({
			streamId: id,
			seq: snapshotSeq,
			state: JSON.parse(encoded),
			savedAt,
		});
	}

	async function loadSnapshot<S>(
		streamId: string,
	): Promise<SnapshotRecord<S> | undefined> {
		const id = requireNonEmpty(streamId, "streamId");
		return read(async (client) => {
			const result = await client.query(
				`SELECT seq, state_codec, state, saved_at FROM ${s}.snapshots
         WHERE stream_id = $1 ORDER BY seq DESC LIMIT 1`,
				[id],
			);
			const row: PgRow | undefined = result.rows[0];
			if (row === undefined) return undefined;
			// SAFETY: the caller names the state type it snapshotted; the column holds that JSON.
			const state = decodeJsonColumn(row, "state", "state_codec") as S;
			return Object.freeze({
				streamId: id,
				seq: int4(row, "seq"),
				state,
				savedAt: String(row.saved_at),
			});
		});
	}

	async function appendQuarantine(
		streamId: string,
		event: EventEnvelope,
		cause: Error,
	): Promise<EventEnvelope> {
		for await (const candidate of readStream(streamId, 1)) {
			const data = candidate.data;
			if (
				candidate.type.endsWith(".Quarantined") &&
				data !== null &&
				typeof data === "object" &&
				!Array.isArray(data) &&
				(data as { offendingSeq?: unknown }).offendingSeq === event.seq
			) {
				return candidate;
			}
		}
		const head = await loadStreamHead(streamId);
		const appendOptions: AppendOptions = {
			expectedSeq: head?.revision ?? 0,
			actor: { kind: "system", id: "storage-postgres" },
			tenant: event.tenant,
			causationId: event.id,
			...(event.correlationId !== undefined
				? { correlationId: event.correlationId }
				: {}),
			...(head !== undefined && head.ownerEpoch > 0n
				? { fenceToken: head.ownerEpoch }
				: {}),
		};
		const aggregate = event.type.split(".")[0] ?? "event";
		const result = await commit({
			streamId,
			events: [
				{
					type: `${aggregate}.Quarantined`,
					data: {
						offendingSeq: event.seq,
						offendingType: event.type,
						reason: cause.message,
					},
					meta: { quarantines: event.id },
				},
			],
			append: appendOptions,
		});
		const appended = result.appended[0];
		if (appended === undefined) {
			throw new EventStoreError(
				"INTEGRITY_FAILURE",
				`quarantine for ${streamId}@${event.seq} not appended`,
			);
		}
		return appended;
	}

	async function fold<S>(
		streamId: string,
		foldOptions: { initialState: S; handlers: FoldHandlers<S> },
	): Promise<FoldResult<S>> {
		const id = requireNonEmpty(streamId, "streamId");
		if (foldOptions.initialState === undefined) {
			throw new StoragePostgresError(
				"invalid-input",
				"foldOptions.initialState is required",
			);
		}
		const handlers = new Map<string, FoldHandlers<S>[string]>();
		for (const [type, handler] of Object.entries(foldOptions.handlers ?? {})) {
			if (handler instanceof Function) handlers.set(type, handler);
		}
		const events: EventEnvelope[] = [];
		for await (const event of readStream(id, 1)) events.push(event);
		const alreadyQuarantined = new Set<number>();
		for (const event of events) {
			const data = event.data;
			if (
				event.type.endsWith(".Quarantined") &&
				data !== null &&
				typeof data === "object" &&
				!Array.isArray(data)
			) {
				const offending = (data as { offendingSeq?: unknown }).offendingSeq;
				if (typeof offending === "number") alreadyQuarantined.add(offending);
			}
		}
		let state: S = cloneJson<S>(foldOptions.initialState);
		const quarantined: FoldResult<S>["quarantined"] = [];
		for (const event of events) {
			if (
				event.type.endsWith(".Quarantined") ||
				alreadyQuarantined.has(event.seq)
			)
				continue;
			const handler = handlers.get(event.type);
			if (handler === undefined) continue;
			try {
				state = cloneJson(handler(cloneJson(state), cloneJson(event)));
			} catch (caught) {
				const marker = await appendQuarantine(id, event, asError(caught));
				const reason = (marker.data as { reason?: unknown } | null)?.reason;
				quarantined.push({
					offendingSeq: event.seq,
					quarantineSeq: marker.seq,
					type: marker.type,
					reason: typeof reason === "string" ? reason : "",
				});
			}
		}
		const head = await loadStreamHead(id);
		return Object.freeze({
			streamId: id,
			seq: head?.revision ?? 0,
			state: cloneJson(state),
			quarantined,
		});
	}

	// ── subscriptions ──────────────────────────────────────────────────────

	function leaseClaimMetric(outcome: string): void {
		metrics.emit([
			{
				name: M.leaseClaims,
				kind: "counter",
				value: 1,
				unit: "{claim}",
				attributes: { outcome },
			},
		]);
	}

	function checkpointMetric(outcome: string): void {
		metrics.emit([
			{
				name: M.checkpointCommits,
				kind: "counter",
				value: 1,
				unit: "{checkpoint}",
				attributes: { outcome },
			},
		]);
	}

	const store: PostgresEventStore = {
		schema: config.schema,
		partitionId: config.partitionId,
		config,
		ready,

		async append(
			streamId: string,
			events: EventInput[],
			opts: AppendOptions,
		): Promise<AppendResult> {
			const result = await commit({ streamId, events, append: opts });
			return Object.freeze({
				streamId: result.streamId,
				appended: result.appended,
				deduped: result.deduped,
				...(result.firstPosition !== undefined
					? { firstPosition: result.firstPosition }
					: {}),
				...(result.lastPosition !== undefined
					? { lastPosition: result.lastPosition }
					: {}),
			});
		},

		commit,

		read(streamId: string, fromSeq = 1): AsyncIterable<EventEnvelope> {
			return readStream(streamId, fromSeq);
		},

		readAll(options?: ReadAllOptions): AsyncIterable<PositionedEvent> {
			return readAllPage(options);
		},

		subscribe(
			filter: StreamFilter,
			handler: (event: EventEnvelope) => void | Promise<void>,
		): Subscription {
			if (!(handler instanceof Function)) {
				throw new StoragePostgresError(
					"invalid-input",
					"handler must be a function",
				);
			}
			const sub: LiveSub = { filter: Object.freeze({ ...filter }), handler };
			live.add(sub);
			if (live.size === 1 && liveStart === undefined) startLive();
			return Object.freeze({
				unsubscribe: () => {
					live.delete(sub);
					if (live.size === 0) {
						liveCursor = undefined;
						liveStart = undefined;
						void stopListener();
					}
				},
			});
		},

		snapshot,
		loadSnapshot,
		loadStreamHead,
		fold,

		async claimSubscription(
			options: ClaimSubscriptionOptions,
		): Promise<SubscriptionLease> {
			const key = parseLeaseKey(options);
			const ttl = parseLeaseTtl(options.leaseTtlMs, config.leaseTtlMs);
			return measured(
				"claim",
				() =>
					tx((client) =>
						claimLease(client, s, key, options.holderId, ttl, clock.now()),
					),
				() => leaseClaimMetric("granted"),
			).catch((error: unknown) => {
				if (
					error instanceof StoragePostgresError &&
					error.failure === "lease-held"
				) {
					leaseClaimMetric("held");
				}
				throw error;
			});
		},

		async renewSubscription(options) {
			const key = parseLeaseKey(options);
			const ttl = parseLeaseTtl(options.leaseTtlMs, config.leaseTtlMs);
			return measured("renew", () =>
				tx((client) =>
					renewLease(
						client,
						s,
						key,
						options.holderId,
						options.fenceToken,
						ttl,
						clock.now(),
					),
				),
			);
		},

		async releaseSubscription(options) {
			const key = parseLeaseKey(options);
			await measured("release", () =>
				tx((client) =>
					releaseLease(
						client,
						s,
						key,
						options.holderId,
						options.fenceToken,
						clock.now(),
					),
				),
			);
		},

		async loadCheckpoint(options) {
			const key = parseLeaseKey(options);
			return read((client) => loadCheckpoint(client, s, key));
		},

		async commitCheckpoint(
			options: CommitCheckpointOptions,
		): Promise<SubscriptionCheckpoint> {
			const key = parseLeaseKey(options);
			try {
				const { checkpoint, outcome } = await measured("checkpoint", () =>
					tx((client) =>
						commitCheckpoint(
							client,
							s,
							key,
							options.position,
							options.fenceToken,
							clock.now(),
						),
					),
				);
				checkpointMetric(outcome);
				return checkpoint;
			} catch (error) {
				const code = error instanceof EventStoreError ? error.code : undefined;
				checkpointMetric(
					code === "STALE_FENCE"
						? "stale"
						: code === "CHECKPOINT_REGRESSION"
							? "regression"
							: "error",
				);
				throw error;
			}
		},

		async resetCheckpoint(
			options: ResetCheckpointOptions,
		): Promise<SubscriptionCheckpoint> {
			if (options.administrative !== true) {
				throw new StoragePostgresError(
					"invalid-input",
					"resetCheckpoint requires administrative: true",
				);
			}
			const key = parseLeaseKey(options);
			return measured("reset", () =>
				tx((client) =>
					resetCheckpoint(
						client,
						s,
						key,
						options.position,
						options.holderId,
						clock.now(),
					),
				),
			);
		},

		async checkpointLog(options) {
			const key = parseLeaseKey(options);
			return read((client) => readCheckpointLog(client, s, key));
		},

		async health(): Promise<StoreHealth> {
			const checks: { name: string; ok: boolean; detail: string }[] = [];
			try {
				const report = await ready();
				checks.push({
					name: "server-version",
					ok: true,
					detail: `PostgreSQL ${report.serverMajorVersion} (minimum ${config.minServerMajorVersion})`,
				});
				const version = await read(async (client) => {
					const result = await client.query(
						`SELECT COALESCE(MAX(version), 0) AS version FROM ${s}.schema_migrations`,
					);
					return result.rows[0] === undefined
						? 0
						: int4(result.rows[0], "version");
				});
				checks.push({
					name: "schema-version",
					ok: version === SCHEMA_VERSION,
					detail: `schema ${config.schema} at ${version}; build ships ${SCHEMA_VERSION}`,
				});
			} catch (caught) {
				const error = asError(caught);
				checks.push({
					name: "connect",
					ok: false,
					detail:
						error instanceof StoragePostgresError
							? `${error.failure}: ${error.message} — ${error.remediation}`
							: error.message,
				});
			}
			return Object.freeze({
				ok: checks.every((check) => check.ok),
				checks: Object.freeze(checks.map((check) => Object.freeze(check))),
			});
		},

		flushTelemetry: () => metrics.flush(),

		close() {
			void store.end();
		},

		end(): Promise<void> {
			if (ending !== undefined) return ending;
			closed = true;
			live.clear();
			ending = (async () => {
				await stopListener();
				if (pumping !== undefined) await pumping.catch(() => undefined);
				if (readyPromise !== undefined)
					await readyPromise.catch(() => undefined);
				if (ownsPool) await pool.end().catch(() => undefined);
			})();
			return ending;
		},
	};
	return Object.freeze(store);
}

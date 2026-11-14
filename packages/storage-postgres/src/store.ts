import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	type AppendOptions,
	type AppendResult,
	type AsyncActorLease,
	type AsyncActorLeaseHost,
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
	type JsonValue,
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
import {
	asError,
	isJsonNumber,
	isJsonString,
	jsonField,
	parseJsonText,
} from "./json.js";
import { type MigrationReport, migrateSchema } from "./migrate.js";
import { SCHEMA_VERSION } from "./migrations/index.js";
import {
	type ParsedAppend,
	type ParsedEventInput,
	parseAppendOptions,
	parseEventInputs,
	parseLeaseTtl,
	requireInt8,
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
	text,
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
	/** Immutable schema-wide stream prefixes requiring a live actor lease. */
	protectedActorStreamPrefixes?: readonly string[];
}>;

export type StoreHealth = Readonly<{
	ok: boolean;
	checks: readonly Readonly<{ name: string; ok: boolean; detail: string }>[];
}>;

/** The PostgreSQL DurableEventStore. Every optional port method is present. */
/** Options for a snapshot write. */
export interface SnapshotWriteOptions {
	/** Required on a protected or leased stream: the live actor lease's fence. */
	readonly fenceToken?: bigint;
}

export interface PostgresEventStore extends DurableEventStore {
	readonly schema: SchemaName;
	readonly partitionId: string;
	readonly config: PostgresStoreConfig;
	/** Distributed lease host sharing this journal and its write fence. */
	readonly actorLeaseHost: AsyncActorLeaseHost;
	/** Read the installed policy from the primary; does not configure it. */
	verifyActorStreamProtection(prefix: string): Promise<void>;
	/** Verify that a separately authenticated application role cannot alter the
	 * journal or assume a role that can. The supervisor connection remains the
	 * sole writer; the application must submit changes through that supervisor. */
	verifyApplicationRoleIsolation(input: {
		applicationRole: string;
		protectedPrefix: string;
		applicationPool: PgPoolLike;
	}): Promise<
		Readonly<{
			database: string;
			schema: string;
			applicationRole: string;
			supervisorRole: string;
		}>
	>;
	/** Connect and migrate (also done lazily by the first operation). */
	ready(): Promise<MigrationReport>;
	fold<S>(
		streamId: string,
		opts: { initialState: S; handlers: FoldHandlers<S> },
	): Promise<FoldResult<S>>;
	/** A protected or leased stream refuses a snapshot without its live fence. */
	snapshot(
		streamId: string,
		state: JsonValue,
		seq: number,
		opts?: SnapshotWriteOptions,
	): Promise<SnapshotRecord>;
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
	const requestedPrefixes =
		options.protectedActorStreamPrefixes === undefined
			? undefined
			: [...new Set(options.protectedActorStreamPrefixes)].sort();
	if (
		requestedPrefixes &&
		(requestedPrefixes.length === 0 ||
			requestedPrefixes.length > 64 ||
			requestedPrefixes.some(
				(prefix) =>
					!isJsonString(prefix) ||
					prefix.length === 0 ||
					Buffer.byteLength(prefix) > 256,
			))
	)
		throw new StoragePostgresError(
			"invalid-config",
			"protected actor stream prefixes must be nonempty and bounded",
		);
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
			if (requestedPrefixes) {
				const wanted = JSON.stringify(requestedPrefixes);
				await client.query("BEGIN");
				try {
					const selected = await client.query(
						`SELECT prefixes FROM ${s}.actor_lease_policy WHERE id = 1 FOR UPDATE`,
					);
					const row = selected.rows[0];
					if (!row)
						throw new StoragePostgresError(
							"unavailable",
							"actor lease policy is missing",
						);
					const stored = text(row, "prefixes");
					if (stored !== wanted) {
						const previous = parseJsonText(stored);
						if (
							!Array.isArray(previous) ||
							previous.length > 64 ||
							previous.some(
								(prefix) =>
									!isJsonString(prefix) ||
									!prefix ||
									Buffer.byteLength(prefix) > 256 ||
									!requestedPrefixes.includes(prefix),
							) ||
							new Set(previous).size !== previous.length
						)
							throw new StoragePostgresError(
								"invalid-config",
								"actor lease stream policy may not remove established protection",
							);
						// Each append holds a shared lock on this policy row through its
						// commit. The exclusive lock above drains old writes before the
						// new protections become effective; no process can downgrade it.
						await client.query(
							`UPDATE ${s}.actor_lease_policy SET prefixes = $1 WHERE id = 1`,
							[wanted],
						);
					}
					await client.query("COMMIT");
				} catch (error) {
					await client.query("ROLLBACK");
					throw error;
				}
			}
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
			attempt.catch((error) => {
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

	async function lockedActorPolicy(
		client: PgClientLike,
	): Promise<readonly string[]> {
		// This shared row prevents policy activation racing a transaction that
		// read the previous policy: the lock remains held through commit.
		const result = await client.query(
			`SELECT prefixes FROM ${s}.actor_lease_policy WHERE id = 1 FOR SHARE`,
		);
		const row = result.rows[0];
		if (!row)
			throw new StoragePostgresError(
				"unavailable",
				"actor lease policy is missing",
			);
		const value = parseJsonText(text(row, "prefixes"));
		if (!Array.isArray(value) || value.length > 64)
			throw new StoragePostgresError(
				"unavailable",
				"actor lease policy is invalid",
			);
		const prefixes: string[] = [];
		for (const prefix of value) {
			if (
				!isJsonString(prefix) ||
				prefix.length === 0 ||
				Buffer.byteLength(prefix) > 256
			)
				throw new StoragePostgresError(
					"unavailable",
					"actor lease policy is invalid",
				);
			prefixes.push(prefix);
		}
		return prefixes;
	}
	async function requireActorPrimary(client: PgClientLike) {
		const result = await client.query("SELECT pg_is_in_recovery() AS replica");
		if (result.rows[0]?.replica !== false)
			throw new StoragePostgresError(
				"unavailable",
				"actor lease authority is not a PostgreSQL primary",
			);
	}
	async function requireActorCommitProtection(client: PgClientLike) {
		const check = await client.query(
			`
SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = 'actor_commit_checks' AND
    t.tgname = 'actor_commit_lease_live' AND t.tgenabled = 'O' AND
    t.tgdeferrable AND t.tginitdeferred AND NOT t.tgisinternal
) AS installed`,
			[config.schema],
		);
		if (check.rows[0]?.installed !== true)
			throw new StoragePostgresError(
				"invalid-config",
				"actor commit lease protection is not installed",
			);
	}
	async function lockActorStream(client: PgClientLike, streamId: string) {
		const timestamp = clock.now();
		await client.query(
			`INSERT INTO ${s}.streams (stream_id, revision, owner_epoch, created_at, updated_at)
			VALUES ($1, 0, 0, $2, $2) ON CONFLICT (stream_id) DO NOTHING`,
			[streamId, timestamp],
		);
		const head = await client.query(
			`SELECT owner_epoch FROM ${s}.streams WHERE stream_id = $1 FOR UPDATE`,
			[streamId],
		);
		const row = head.rows[0];
		if (!row)
			throw new StoragePostgresError(
				"unavailable",
				"actor stream head is missing",
			);
		return int8(row, "owner_epoch");
	}
	async function validActorLease(
		client: PgClientLike,
		streamId: string,
		holderId: string,
		fenceToken: bigint,
	) {
		const ownerEpoch = await lockActorStream(client, streamId);
		const found = await client.query(
			`SELECT holder_id, fence_token, (NOT released AND expires_at > clock_timestamp()) AS active
			FROM ${s}.actor_leases WHERE stream_id = $1`,
			[streamId],
		);
		const row = found.rows[0];
		if (
			row?.active !== true ||
			text(row, "holder_id") !== holderId ||
			int8(row, "fence_token") !== fenceToken ||
			ownerEpoch !== fenceToken
		)
			throw new StaleFenceError(streamId, fenceToken, ownerEpoch);
	}
	const actorLeaseHost: AsyncActorLeaseHost = Object.freeze({
		async acquire(
			rawKey: string,
			request: { holderId: string },
		): Promise<AsyncActorLease> {
			const key = requireNonEmpty(rawKey, "actor key");
			const holderId = requireNonEmpty(request?.holderId, "holderId");
			if (Buffer.byteLength(key) > 4096 || Buffer.byteLength(holderId) > 512)
				throw new StoragePostgresError(
					"invalid-input",
					"actor lease identity exceeds its bound",
				);
			const grant = await tx(async (client) => {
				await requireActorPrimary(client);
				await lockedActorPolicy(client);
				const previous = await lockActorStream(client, key);
				const found = await client.query(
					`SELECT (NOT released AND expires_at > clock_timestamp()) AS active FROM ${s}.actor_leases WHERE stream_id = $1`,
					[key],
				);
				if (found.rows[0]?.active === true)
					throw new StoragePostgresError(
						"lease-held",
						"actor stream is already leased",
					);
				const fenceToken = requireInt8(previous + 1n, "actor fence");
				await client.query(
					`UPDATE ${s}.streams SET owner_epoch = $2, updated_at = $3 WHERE stream_id = $1`,
					[key, fenceToken.toString(), clock.now()],
				);
				const inserted = await client.query(
					`INSERT INTO ${s}.actor_leases (stream_id, holder_id, fence_token, expires_at, released)
					VALUES ($1, $2, $3, clock_timestamp() + ($4 * INTERVAL '1 millisecond'), false)
					ON CONFLICT (stream_id) DO UPDATE SET holder_id = EXCLUDED.holder_id, fence_token = EXCLUDED.fence_token,
						expires_at = EXCLUDED.expires_at, released = false
					RETURNING (extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_ms`,
					[key, holderId, fenceToken.toString(), config.leaseTtlMs],
				);
				const row = inserted.rows[0];
				if (!row)
					throw new StoragePostgresError(
						"unavailable",
						"actor lease could not be recorded",
					);
				const expiresMs = Number(text(row, "expires_ms"));
				if (!Number.isSafeInteger(expiresMs))
					throw new StoragePostgresError(
						"unavailable",
						"actor lease expiry is invalid",
					);
				return { fenceToken, expiresAt: new Date(expiresMs).toISOString() };
			});
			return Object.freeze({
				key,
				holderId,
				...grant,
				async revalidate() {
					await tx(async (client) => {
						await requireActorPrimary(client);
						await lockedActorPolicy(client);
						await validActorLease(client, key, holderId, grant.fenceToken);
					});
				},
				async release() {
					await tx(async (client) => {
						await requireActorPrimary(client);
						await lockedActorPolicy(client);
						await lockActorStream(client, key);
						// A delayed release can never release a later holder.
						await client.query(
							`UPDATE ${s}.actor_leases SET released = true WHERE stream_id = $1 AND holder_id = $2 AND fence_token = $3`,
							[key, holderId, grant.fenceToken.toString()],
						);
					});
				},
			});
		},
	});

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
		listening.catch((error) => {
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
		liveStart.catch((error) => countError(asError(error)));
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

	/**
	 * Refuse a write to a protected or leased stream unless `fenceToken` names
	 * the live lease and the head's owner epoch. Call with the stream head row
	 * locked FOR UPDATE and the actor policy row locked.
	 */
	async function checkActorWrite(
		client: PgClientLike,
		actorPolicy: readonly string[],
		streamId: string,
		ownerEpoch: bigint,
		fenceToken: bigint | undefined,
	): Promise<void> {
		const leaseResult = await client.query(
			`SELECT fence_token, (NOT released AND expires_at > clock_timestamp()) AS active
			FROM ${s}.actor_leases WHERE stream_id = $1`,
			[streamId],
		);
		const actorLease = leaseResult.rows[0];
		if (
			!actorLease &&
			!actorPolicy.some((prefix) => streamId.startsWith(prefix))
		)
			return;
		await requireActorPrimary(client);
		if (fenceToken === undefined)
			throw new MissingFenceError(streamId, ownerEpoch);
		if (
			actorLease?.active !== true ||
			int8(actorLease, "fence_token") !== fenceToken ||
			ownerEpoch !== fenceToken
		)
			throw new StaleFenceError(streamId, fenceToken, ownerEpoch);
		const checkId = randomUUID();
		await client.query(
			`INSERT INTO ${s}.actor_commit_checks (id, stream_id, fence_token) VALUES ($1, $2, $3)`,
			[checkId, streamId, fenceToken.toString()],
		);
		await client.query(`DELETE FROM ${s}.actor_commit_checks WHERE id = $1`, [
			checkId,
		]);
	}

	async function commitIn(
		client: PgClientLike,
		streamId: string,
		inputs: readonly ParsedEventInput[],
		append: ParsedAppend,
		effects: DurableCommitRequest["effects"],
	): Promise<DurableCommitResult & { lastPositionRaw: bigint | undefined }> {
		const now = clock.now();
		const actorPolicy = await lockedActorPolicy(client);
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
		await checkActorWrite(
			client,
			actorPolicy,
			streamId,
			ownerEpoch,
			append.fenceToken,
		);

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
				if (isJsonString(key)) committed.set(key, rowToEnvelope(row));
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
		state: JsonValue,
		seq: number,
		opts?: SnapshotWriteOptions,
	): Promise<SnapshotRecord> {
		const id = requireNonEmpty(streamId, "streamId");
		const snapshotSeq = requireNonNegInt(seq, "seq");
		const fenceToken =
			opts?.fenceToken === undefined
				? undefined
				: requireInt8(opts.fenceToken, "fenceToken");
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
			const actorPolicy = await lockedActorPolicy(client);
			await client.query(
				`INSERT INTO ${s}.streams (stream_id, revision, owner_epoch, created_at, updated_at)
         VALUES ($1, 0, 0, $2, $2) ON CONFLICT (stream_id) DO NOTHING`,
				[id, savedAt],
			);
			// FOR UPDATE serialises against acquire's owner-epoch bump, as appends do.
			const head = await client.query(
				`SELECT revision, owner_epoch FROM ${s}.streams WHERE stream_id = $1 FOR UPDATE`,
				[id],
			);
			const headRow = head.rows[0];
			if (headRow === undefined)
				throw new EventStoreError(
					"INTEGRITY_FAILURE",
					`stream head missing for ${id}`,
				);
			const headSeq = int4(headRow, "revision");
			await checkActorWrite(
				client,
				actorPolicy,
				id,
				int8(headRow, "owner_epoch"),
				fenceToken,
			);
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
				savedAt: text(row, "saved_at"),
			});
		});
	}

	async function appendQuarantine(
		streamId: string,
		event: EventEnvelope,
		cause: Error,
	): Promise<EventEnvelope> {
		for await (const candidate of readStream(streamId, 1)) {
			if (
				candidate.type.endsWith(".Quarantined") &&
				jsonField(candidate.data, "offendingSeq") === event.seq
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
		};
		if (event.correlationId !== undefined) {
			appendOptions.correlationId = event.correlationId;
		}
		// Quarantine must not bypass fencing: continue at the stream's epoch.
		if (head !== undefined && head.ownerEpoch > 0n) {
			appendOptions.fenceToken = head.ownerEpoch;
		}
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
			if (!event.type.endsWith(".Quarantined")) continue;
			const offending = jsonField(event.data, "offendingSeq");
			if (isJsonNumber(offending)) alreadyQuarantined.add(offending);
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
				const reason = jsonField(marker.data, "reason");
				quarantined.push({
					offendingSeq: event.seq,
					quarantineSeq: marker.seq,
					type: marker.type,
					reason: isJsonString(reason) ? reason : "",
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
		actorLeaseHost,
		async verifyActorStreamProtection(prefix: string) {
			const expected = requireNonEmpty(prefix, "actor stream prefix");
			await tx(async (client) => {
				await requireActorPrimary(client);
				const policy = await lockedActorPolicy(client);
				if (!policy.includes(expected))
					throw new StoragePostgresError(
						"invalid-config",
						"required actor stream protection is not installed",
					);
				await requireActorCommitProtection(client);
			});
		},
		async verifyApplicationRoleIsolation(input) {
			const applicationRole = requireNonEmpty(
				input.applicationRole,
				"application role",
			);
			const prefix = requireNonEmpty(
				input.protectedPrefix,
				"actor stream prefix",
			);
			if (!/^[a-z_][a-z0-9_]{0,62}(?![\s\S])/u.test(applicationRole))
				throw new StoragePostgresError(
					"invalid-input",
					"application role is invalid",
				);
			return tx(async (client) => {
				await requireActorPrimary(client);
				const policy = await lockedActorPolicy(client);
				if (!policy.includes(prefix))
					throw new StoragePostgresError(
						"invalid-config",
						"required actor stream protection is not installed",
					);
				await requireActorCommitProtection(client);
				// All reachable roles are considered, including NOINHERIT grants a
				// session may explicitly assume with SET ROLE. PUBLIC grants are
				// included by PostgreSQL's privilege predicates.
				const result = await client.query(
					`
WITH application AS (
  SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname = $1 AND rolcanlogin
), reachable AS (
  SELECT r.* FROM pg_catalog.pg_roles r, application a
  WHERE r.oid = a.oid OR pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
), protected_schema AS (
  SELECT oid, nspowner FROM pg_catalog.pg_namespace WHERE nspname = $2
), protected_tables AS (
  SELECT c.oid, c.relname, c.relowner FROM pg_catalog.pg_class c, protected_schema s
  WHERE c.relnamespace = s.oid AND c.relkind IN ('r', 'p')
), required_tables AS (
  SELECT unnest(ARRAY['streams','events','snapshots','actor_leases','actor_lease_policy',
    'actor_commit_checks','queue_messages','durable_timers','cron_schedules','outbox']) AS name
)
SELECT a.rolname AS application_role, current_user::text AS supervisor_role,
  current_database()::text AS database_name, s.oid::text AS schema_id,
  (pg_catalog.pg_has_role(a.oid, current_user::regrole, 'MEMBER') OR
   EXISTS (SELECT 1 FROM reachable r WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR
     r.rolreplication OR r.rolbypassrls OR r.rolname LIKE 'pg\\_%' ESCAPE '\\' OR
	 r.oid = s.nspowner OR pg_catalog.has_schema_privilege(r.oid, s.oid, 'CREATE') OR
	 EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid)) OR
   EXISTS (SELECT 1 FROM reachable r, protected_tables t WHERE r.oid = t.relowner OR
     pg_catalog.has_table_privilege(r.oid, t.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR
     pg_catalog.has_any_column_privilege(r.oid, t.oid, 'INSERT,UPDATE,REFERENCES')) OR
   EXISTS (SELECT 1 FROM reachable r, pg_catalog.pg_class c, pg_catalog.pg_namespace n
     WHERE c.relnamespace = n.oid AND n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('v','m','f') AND
     pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')) OR
   EXISTS (SELECT 1 FROM reachable r, pg_catalog.pg_foreign_server f
     WHERE pg_catalog.has_server_privilege(r.oid, f.oid, 'USAGE')) OR
   EXISTS (SELECT 1 FROM reachable r, pg_catalog.pg_proc p, pg_catalog.pg_namespace n, pg_catalog.pg_language l
     WHERE p.pronamespace = n.oid AND p.prolang = l.oid AND n.nspname NOT IN ('pg_catalog','information_schema') AND
       (p.prosecdef OR l.lanname NOT IN ('sql','plpgsql')) AND pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
  ) AS unsafe_application,
  NOT EXISTS (SELECT 1 FROM required_tables x WHERE NOT EXISTS (
    SELECT 1 FROM protected_tables t WHERE t.relname = x.name AND
      pg_catalog.has_table_privilege(current_user, t.oid, 'SELECT') AND
      pg_catalog.has_table_privilege(current_user, t.oid, 'INSERT') AND
      pg_catalog.has_table_privilege(current_user, t.oid, 'UPDATE') AND
      pg_catalog.has_table_privilege(current_user, t.oid, 'DELETE')
  )) AS supervisor_can_write
FROM application a, protected_schema s`,
					[applicationRole, config.schema],
				);
				const row = result.rows[0];
				if (
					row?.unsafe_application !== false ||
					row.supervisor_can_write !== true ||
					text(row, "application_role") !== applicationRole ||
					!text(row, "schema_id")
				)
					throw new StoragePostgresError(
						"invalid-config",
						"application role can bypass the protected actor stream boundary",
					);
				const supervisorRole = text(row, "supervisor_role");
				if (supervisorRole === applicationRole)
					throw new StoragePostgresError(
						"invalid-config",
						"application and supervisor roles must be separate",
					);
				const application = await input.applicationPool.connect();
				try {
					const challenge = `hobo-boundary-${randomUUID()}`;
					await application.query("BEGIN READ ONLY");
					await application.query(
						"SELECT set_config('application_name', $1, true)",
						[challenge],
					);
					const observation = await application.query(
						`
SELECT current_user::text AS role_name, session_user::text AS login_name,
  current_database()::text AS database_name, pg_backend_pid()::text AS backend_id,
  (SELECT oid::text FROM pg_catalog.pg_namespace WHERE nspname = $1) AS schema_id`,
						[config.schema],
					);
					const observed = observation.rows[0];
					if (
						!observed ||
						text(observed, "role_name") !== applicationRole ||
						text(observed, "login_name") !== applicationRole ||
						text(observed, "database_name") !== text(row, "database_name") ||
						text(observed, "schema_id") !== text(row, "schema_id")
					)
						throw new StoragePostgresError(
							"invalid-config",
							"application credential does not authenticate the restricted role and database",
						);
					const witness = await client.query(
						`
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
  WHERE pid = $1::integer AND application_name = $2 AND usename = $3 AND datname = current_database()) AS matched`,
						[text(observed, "backend_id"), challenge, applicationRole],
					);
					if (witness.rows[0]?.matched !== true)
						throw new StoragePostgresError(
							"invalid-config",
							"application and supervisor do not share the verified database authority",
						);
				} finally {
					await application.query("ROLLBACK").catch(() => undefined);
					application.release();
				}
				return Object.freeze({
					database: text(row, "database_name"),
					schema: config.schema,
					applicationRole,
					supervisorRole,
				});
			});
		},
		ready,

		async append(
			streamId: string,
			events: EventInput[],
			opts: AppendOptions,
		): Promise<AppendResult> {
			const result = await commit({ streamId, events, append: opts });
			const out: AppendResult = {
				streamId: result.streamId,
				appended: result.appended,
				deduped: result.deduped,
			};
			if (result.firstPosition !== undefined) {
				out.firstPosition = result.firstPosition;
			}
			if (result.lastPosition !== undefined) {
				out.lastPosition = result.lastPosition;
			}
			return Object.freeze(out);
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
			).catch((error) => {
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

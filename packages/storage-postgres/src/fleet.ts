/**
 * The PostgreSQL EventStore on a fleet of backends (ADR-0135, ADR-0179).
 *
 * One backend is the writer; the others are standbys on other vendors. Which
 * one writes is the fleet's assignment register (`@hobo/data-postgres`),
 * kept on every member and decided by majority. This experimental store does
 * not yet fence in-flight writes at the database transaction boundary, so a
 * move can lose writes and must not be relied on for safe failover:
 *
 * - **Every call goes to the writer.** The store resolves the assignment and
 *   trusts it for `leaseMs`, measured from when the read started. A sealed
 *   fleet (a planned move in flight), an undecided epoch or no majority
 *   refuses the call with a retryable `unavailable`; the caller retries and
 *   a new call. A call already dispatched under a prior lease can still write.
 * - **`tick()` keeps the fleet converged.** It runs `reconcileFleet` with the
 *   policy the Bindle declared (`continuityFleetPlan`): settle the register,
 *   probe, copy the writer to every standby, measure, decide, act. The host
 *   calls it on the copy cadence. A tick that is interrupted (the process
 *   dies, a connection drops mid-copy) leaves nothing half done: a copy is
 *   one transaction on the standby, and a move is a sealed register entry
 *   that the next tick completes or undoes. A delayed write can land after the
 *   final copy and be lost when the old writer is overwritten.
 * - **A move follows the writer.** When the register names a new writer, the
 *   next call opens that member's store; live subscriptions move with it.
 *   Delivery across a move is not yet proven when writes race the move.
 *
 * The copy is a snapshot of every table in the store's schema except the
 * fleet's own control tables and `schema_migrations` (each member migrates
 * itself). Sequences travel with their tables, so positions keep increasing
 * on the new writer.
 */
import {
	type ContinuityFleetPlan,
	continuityBudgetCheck,
	type FleetBudgetCheck,
	type FleetFinancialModel,
	readCurrentAssignment,
} from "@hobo/backend-fleet";
import type {
	AppendOptions,
	AppendResult,
	DurableCommitRequest,
	DurableCommitResult,
	DurableEventStore,
	EventEnvelope,
	EventInput,
	JsonValue,
	PositionedEvent,
	ReadAllOptions,
	SnapshotRecord,
	StreamFilter,
	Subscription,
} from "@hobo/core";
import {
	type FleetBackend,
	type FleetReconcileReport,
	type FleetSchemaRole,
	parseFleetLayout,
	reconcileFleet,
	type SqlExecutor,
	type SqlSession,
	sqlAssignmentRegister,
} from "@hobo/data-postgres";
import pg from "pg";

import { POSTGRES_STORE_DEFAULTS, parsePostgresStoreConfig } from "./config.js";
import { StoragePostgresError } from "./errors.js";
import { parseSchemaName, quoteSchema } from "./identifiers.js";
import { createPgListener, type PgPoolLike, type PgRow } from "./pg.js";
import { createPostgresEventStore, type PostgresEventStore } from "./store.js";

export type PostgresFleetMember = Readonly<{
	/** Stable id: the name the register records (`neon-eu`, `supabase`). */
	id: string;
	connectionString: string;
}>;

export type PostgresFleetEventStoreOptions = Readonly<{
	/** In configured order; the first is the writer of an empty fleet. */
	members: readonly PostgresFleetMember[];
	/**
	 * Members that hold only the assignment register, on other failure
	 * domains, so a fleet of two can still decide a failover by majority.
	 */
	witnesses?: readonly PostgresFleetMember[];
	plan: ContinuityFleetPlan;
	schema?: string;
	poolSize?: number;
	statementTimeoutMs?: number;
	minServerMajorVersion?: number;
	applicationName?: string;
	/** How long a resolved writer is trusted (default 30 s). */
	leaseMs?: number;
	/** Added to a lease while a move waits for writers to stop (default 5 s). */
	graceMs?: number;
	/** Plans per member, in their billing units; none means cost-blind. */
	models?: readonly FleetFinancialModel[];
	checkBudget?: FleetBudgetCheck;
	/** Identifies this process in the register. */
	decidedBy: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (event: string) => void;
	/** Tests inject pools; otherwise one `pg.Pool` per member. */
	pool?: (member: PostgresFleetMember, schema: string) => PgPoolLike;
}>;

export interface PostgresFleetEventStore extends DurableEventStore {
	/** One fleet tick: settle, copy, decide, act. */
	tick(): Promise<FleetReconcileReport>;
	/** The writer the store last resolved, if any. */
	writer(): string | undefined;
	end(): Promise<void>;
}

/** A caller's subscription, re-attached to each new writer. */
interface FollowedSubscription {
	readonly filter: StreamFilter;
	readonly handler: (event: EventEnvelope) => void | Promise<void>;
	writer: string | undefined;
	inner: Subscription | undefined;
}

const MIGRATIONS_TABLE = "schema_migrations";
const CONTROL_PREFIX = "hobo_fleet_";

function memberPool(member: PostgresFleetMember, schema: string): PgPoolLike {
	const pool = new pg.Pool({
		connectionString: member.connectionString,
		max: POSTGRES_STORE_DEFAULTS.poolSize,
		connectionTimeoutMillis: POSTGRES_STORE_DEFAULTS.connectionTimeoutMs,
		// The fleet names its tables unqualified; the store qualifies its own.
		options: `-c search_path=${schema}`,
	});
	pool.on("error", () => {});
	return pool;
}

/** The fleet's SQL port over a pool: text in, text out, pinned sessions. */
function executorOf(pool: PgPoolLike): SqlExecutor {
	const asText = (rows: readonly PgRow[]) =>
		rows.map((row) =>
			Object.fromEntries(
				Object.entries(row).map(([key, value]) => [
					key,
					value === null ? null : String(value),
				]),
			),
		);
	const sessionOf = (client: Awaited<ReturnType<PgPoolLike["connect"]>>) => ({
		async query(
			sql: string,
			parameters?: readonly (string | number | boolean | null)[],
		) {
			const result = await client.query(sql, parameters);
			return { rows: asText(result.rows) };
		},
	});
	return {
		async query(sql, parameters) {
			const client = await pool.connect();
			try {
				return await sessionOf(client).query(sql, parameters);
			} finally {
				client.release();
			}
		},
		async session<T>(run: (session: SqlSession) => Promise<T>): Promise<T> {
			const client = await pool.connect();
			try {
				const result = await run(sessionOf(client));
				client.release();
				return result;
			} catch (error) {
				client.release(true);
				throw error;
			}
		},
	};
}

function unavailable(message: string): StoragePostgresError {
	return new StoragePostgresError("unavailable", message);
}

/** Open the fleet. Nothing connects until the first call or tick. */
export function createPostgresFleetEventStore(
	options: PostgresFleetEventStoreOptions,
): PostgresFleetEventStore {
	if (
		new Set([...options.members, ...(options.witnesses ?? [])].map((m) => m.id))
			.size !==
		options.members.length + (options.witnesses?.length ?? 0)
	)
		throw new StoragePostgresError(
			"invalid-config",
			"every member and witness needs its own id",
		);
	if (options.members.length === 0)
		throw new StoragePostgresError(
			"invalid-config",
			"a fleet needs at least one member",
		);
	if (options.plan.copy !== "snapshot" && options.members.length > 1)
		throw new StoragePostgresError(
			"invalid-config",
			"a PostgreSQL fleet with standbys needs a snapshot continuity plan; rebuildable state cannot fail over to an empty journal",
		);
	const schemaName = parseSchemaName(
		options.schema ?? POSTGRES_STORE_DEFAULTS.schema,
	);
	const schema: string = schemaName;
	const now = options.now ?? (() => Date.now());
	const leaseMs = options.leaseMs ?? 30_000;
	const layout = parseFleetLayout({
		dataPrefix: "",
		controlPrefix: CONTROL_PREFIX,
		excludedTables: [MIGRATIONS_TABLE],
	});
	const pools = new Map<string, PgPoolLike>();
	const stores = new Map<string, PostgresEventStore>();
	const backends: FleetBackend[] = options.members.map((member) => {
		const pool = (options.pool ?? memberPool)(member, schema);
		pools.set(member.id, pool);
		return { id: member.id, executor: executorOf(pool) };
	});
	const witnesses: FleetBackend[] = (options.witnesses ?? []).map((member) => {
		const pool = (options.pool ?? memberPool)(member, schema);
		pools.set(member.id, pool);
		return { id: member.id, executor: executorOf(pool) };
	});
	const register = sqlAssignmentRegister([...backends, ...witnesses], layout);
	const memberById = new Map(options.members.map((m) => [m.id, m]));

	const storeFor = (id: string): PostgresEventStore => {
		const existing = stores.get(id);
		if (existing !== undefined) return existing;
		const pool = pools.get(id);
		if (pool === undefined || !memberById.has(id))
			throw unavailable(`the register names ${id}, which is not a member`);
		const store = createPostgresEventStore({
			config: {
				schema,
				...(options.poolSize !== undefined
					? { poolSize: options.poolSize }
					: undefined),
				...(options.statementTimeoutMs !== undefined
					? { statementTimeoutMs: options.statementTimeoutMs }
					: undefined),
				...(options.minServerMajorVersion !== undefined
					? { minServerMajorVersion: options.minServerMajorVersion }
					: undefined),
				applicationName: options.applicationName ?? "hobo-fleet",
			},
			pool,
			// LISTEN needs its own connection to this member, not the pool's.
			listener: () =>
				createPgListener(
					parsePostgresStoreConfig({
						connectionString: memberById.get(id)?.connectionString ?? "",
						schema,
					}),
				),
			clock: { now: () => new Date(now()).toISOString() },
		});
		stores.set(id, store);
		return store;
	};

	let resolved: { writer: string; readAt: number } | undefined;
	const subscriptions = new Set<FollowedSubscription>();

	const follow = (writer: string) => {
		for (const subscription of subscriptions) {
			if (subscription.writer === writer) continue;
			subscription.inner?.unsubscribe();
			subscription.inner = storeFor(writer).subscribe(
				subscription.filter,
				subscription.handler,
			);
			subscription.writer = writer;
		}
	};

	const writerStore = async (): Promise<PostgresEventStore> => {
		const started = now();
		if (resolved !== undefined && started - resolved.readAt < leaseMs)
			return storeFor(resolved.writer);
		const resolution = await readCurrentAssignment(register);
		if (resolution.status !== "current") {
			resolved = undefined;
			throw unavailable(
				resolution.status === "empty"
					? "the fleet has no writer yet; run a tick"
					: `the fleet's writer is ${resolution.status}`,
			);
		}
		const { assignment } = resolution;
		if (assignment.sealed || assignment.active === undefined) {
			resolved = undefined;
			throw unavailable(
				assignment.sealed
					? `the journal is moving to ${assignment.target}; retry shortly`
					: "the fleet has deliberately no writer",
			);
		}
		resolved = { writer: assignment.active, readAt: started };
		const store = storeFor(assignment.active);
		await store.ready();
		follow(assignment.active);
		return store;
	};

	const ensureSchema = async (
		backend: FleetBackend,
		_role: FleetSchemaRole,
	): Promise<void> => {
		await storeFor(backend.id).ready();
	};

	const tick = async (): Promise<FleetReconcileReport> => {
		for (const backend of backends) {
			try {
				await storeFor(backend.id).ready();
			} catch {
				// An unreachable member is the fleet's to judge, not the tick's.
			}
		}
		for (const witness of witnesses) {
			try {
				await witness.executor.query(
					`CREATE SCHEMA IF NOT EXISTS ${quoteSchema(schemaName)}`,
				);
			} catch {
				// A silent witness is one fewer vote, not a failed tick.
			}
		}
		const report = await reconcileFleet({
			backends,
			witnesses,
			layout,
			models: options.models ?? [],
			policy: options.plan.fleet,
			leaseMs,
			graceMs: options.graceMs ?? 5_000,
			ensureSchema,
			checkBudget: continuityBudgetCheck(options.plan, options.checkBudget),
			meter: undefined,
			limits: undefined,
			decidedBy: options.decidedBy,
			now,
			sleep:
				options.sleep ??
				((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
			log: (event) => options.log?.(event.kind),
		});
		// A tick may have moved the writer: re-resolve on the next call.
		resolved = undefined;
		return report;
	};

	async function* readThrough<T>(
		open: (store: PostgresEventStore) => AsyncIterable<T>,
	): AsyncIterable<T> {
		yield* open(await writerStore());
	}

	return {
		tick,
		writer: () => resolved?.writer,
		async append(
			streamId: string,
			events: EventInput[],
			opts: AppendOptions,
		): Promise<AppendResult> {
			return (await writerStore()).append(streamId, events, opts);
		},
		read: (streamId: string, fromSeq?: number) =>
			readThrough((store) => store.read(streamId, fromSeq)),
		readAll: (options?: ReadAllOptions): AsyncIterable<PositionedEvent> =>
			readThrough((store) => store.readAll(options)),
		subscribe(filter, handler) {
			const entry: FollowedSubscription = {
				filter,
				handler,
				writer: undefined,
				inner: undefined,
			};
			subscriptions.add(entry);
			if (resolved !== undefined) follow(resolved.writer);
			else void writerStore().catch(() => {});
			return {
				unsubscribe() {
					entry.inner?.unsubscribe();
					subscriptions.delete(entry);
				},
			};
		},
		async snapshot(
			streamId: string,
			state: JsonValue,
			seq: number,
		): Promise<SnapshotRecord> {
			return (await writerStore()).snapshot(streamId, state, seq);
		},
		getStreamHead(streamId: string) {
			return resolved === undefined
				? undefined
				: storeFor(resolved.writer).getStreamHead?.(streamId);
		},
		async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
			return (await writerStore()).commit(request);
		},
		async loadSnapshot<S>(streamId: string) {
			return (await writerStore()).loadSnapshot<S>(streamId);
		},
		async claimSubscription(claim) {
			return (await writerStore()).claimSubscription(claim);
		},
		async renewSubscription(renewal) {
			return (await writerStore()).renewSubscription(renewal);
		},
		async releaseSubscription(release) {
			return (await writerStore()).releaseSubscription(release);
		},
		async loadCheckpoint(request) {
			return (await writerStore()).loadCheckpoint(request);
		},
		async commitCheckpoint(request) {
			return (await writerStore()).commitCheckpoint(request);
		},
		async resetCheckpoint(request) {
			return (await writerStore()).resetCheckpoint(request);
		},
		async end() {
			for (const subscription of subscriptions)
				subscription.inner?.unsubscribe();
			subscriptions.clear();
			for (const store of stores.values()) await store.end();
			for (const pool of pools.values()) await pool.end();
		},
	};
}

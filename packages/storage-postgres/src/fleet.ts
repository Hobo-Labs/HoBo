import {
	assignmentKey,
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
	SnapshotWriteOptions,
	StreamFilter,
	Subscription,
} from "@hobo/core";
import {
	FLEET_LOCK_CLASS,
	type FleetBackend,
	type FleetReconcileReport,
	type FleetSchemaRole,
	parseFleetLayout,
	readAssignmentRows,
	reconcileFleet,
	type SqlExecutor,
	type SqlSession,
	sqlAssignmentRegister,
} from "@hobo/data-postgres";
import pg from "pg";

import { POSTGRES_STORE_DEFAULTS, parsePostgresStoreConfig } from "./config.js";
import { StoragePostgresError } from "./errors.js";
import {
	createFleetBackups,
	type FleetBackup,
	type FleetBackupOutcome,
	type FleetBackups,
} from "./fleet-backups.js";
import { parseSchemaName, quoteSchema } from "./identifiers.js";
import {
	createPgListener,
	type PgClientLike,
	type PgPoolLike,
	type PgRow,
} from "./pg.js";
import { createPostgresEventStore, type PostgresEventStore } from "./store.js";

export type PostgresFleetMember = Readonly<{
	id: string;
	connectionString: string;
}>;

export type PostgresFleetEventStoreOptions = Readonly<{
	members: readonly PostgresFleetMember[];
	witnesses?: readonly PostgresFleetMember[];
	plan: ContinuityFleetPlan;
	schema?: string;
	poolSize?: number;
	statementTimeoutMs?: number;
	minServerMajorVersion?: number;
	applicationName?: string;
	leaseMs?: number;
	graceMs?: number;
	models?: readonly FleetFinancialModel[];
	checkBudget?: FleetBudgetCheck;
	backupTo?: PostgresFleetMember;
	decidedBy: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (event: string) => void;
	pool?: (member: PostgresFleetMember, schema: string) => PgPoolLike;
}>;

export type PostgresFleetTickReport = FleetReconcileReport &
	Readonly<{ backup: FleetBackupOutcome | undefined }>;

export interface PostgresFleetEventStore extends DurableEventStore {
	tick(): Promise<PostgresFleetTickReport>;
	backupsPlaced(): boolean;
	backups(): Promise<readonly FleetBackup[]>;
	restore(input: {
		readonly into: string;
		readonly name?: string;
	}): Promise<FleetBackup>;
	writer(): string | undefined;
	end(): Promise<void>;
}

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
		options: `-c search_path=${schema}`,
	});
	pool.on("error", () => {});
	return pool;
}

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
	const backupPools = new Set<PgPoolLike>();
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
	const backupMember =
		options.plan.backups.everyMs > 0
			? (options.backupTo ?? options.witnesses?.[0])
			: undefined;
	const backups: FleetBackups | undefined =
		backupMember === undefined
			? undefined
			: createFleetBackups({
					schema: schemaName,
					everyMs: options.plan.backups.everyMs,
					kept: options.plan.backups.kept,
					layout,
					pool: (schema) => {
						const pool = (options.pool ?? memberPool)(backupMember, schema);
						backupPools.add(pool);
						return pool;
					},
					executor: executorOf,
				});
	const memberById = new Map(options.members.map((m) => [m.id, m]));

	const registerTable = `${quoteSchema(schemaName)}.${layout.assignmentTable}`;
	const fenceWrite = async (client: PgClientLike, id: string) => {
		await client.query(`LOCK TABLE ${registerTable} IN SHARE MODE`);
		const newest = (
			await client.query(
				`SELECT active, sealed::text AS sealed FROM ${registerTable} ORDER BY epoch DESC LIMIT 1`,
			)
		).rows[0];
		if (newest?.active !== id || newest.sealed !== "false") {
			resolved = undefined;
			throw unavailable(
				`${id} is no longer the fleet's writer; retry on the new writer`,
			);
		}
	};

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
			listener: () =>
				createPgListener(
					parsePostgresStoreConfig({
						connectionString: memberById.get(id)?.connectionString ?? "",
						schema,
					}),
				),
			clock: { now: () => new Date(now()).toISOString() },
			writeFence: (client) => fenceWrite(client, id),
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

	const tick = async (): Promise<PostgresFleetTickReport> => {
		for (const backend of backends) {
			try {
				await storeFor(backend.id).ready();
			} catch {
			}
		}
		for (const witness of witnesses) {
			try {
				await witness.executor.query(
					`CREATE SCHEMA IF NOT EXISTS ${quoteSchema(schemaName)}`,
				);
			} catch {
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
		resolved = undefined;
		const writer = report.assignment?.active;
		const source = backends.find((backend) => backend.id === writer);
		const backup =
			backups !== undefined &&
			report.status === "settled" &&
			report.assignment?.sealed === false &&
			source !== undefined
				? await backups.run({
						source: source.id,
						executor: source.executor,
						nowMs: now(),
					})
				: undefined;
		if (backup?.kind === "failed") options.log?.("backup-failed");
		return { ...report, backup };
	};

	async function* readThrough<T>(
		open: (store: PostgresEventStore) => AsyncIterable<T>,
	): AsyncIterable<T> {
		yield* open(await writerStore());
	}

	return {
		tick,
		writer: () => resolved?.writer,
		backupsPlaced: () => backups !== undefined,
		backups: async () => (backups === undefined ? [] : backups.list()),
		async restore({ into, name }) {
			if (backups === undefined)
				throw new StoragePostgresError(
					"invalid-config",
					"this fleet's plan keeps no backups",
				);
			const target = backends.find((backend) => backend.id === into);
			if (target === undefined)
				throw new StoragePostgresError(
					"invalid-config",
					`${into} is not a member of the fleet`,
				);
			const current = await readCurrentAssignment(register);
			if (current.status !== "current")
				throw unavailable(
					`the fleet's register is ${current.status}; restore needs a decided writer`,
				);
			await storeFor(into).ready();
			return backups.restore({
				target: target.executor,
				...(name !== undefined ? { name } : undefined),
				admit: async (to) => {
					const lock = await to.query(
						"SELECT pg_try_advisory_xact_lock($1::int, hashtext($2))::text AS locked",
						[FLEET_LOCK_CLASS, layout.assignmentTable],
					);
					if (lock.rows[0]?.locked !== "true")
						throw unavailable(`${into} is busy with another fleet operation`);
					await to.query(`LOCK TABLE ${registerTable} IN EXCLUSIVE MODE`);
					const local = (await readAssignmentRows(to, layout, 1)).at(-1);
					if (
						local === undefined ||
						assignmentKey(local) !== assignmentKey(current.assignment)
					)
						throw unavailable(`${into}'s assignment changed; retry restore`);
					if (local.active === into)
						throw unavailable(
							`${into} is the fleet's writer; restore into a standby, then move to it`,
						);
				},
			});
		},
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
			opts?: SnapshotWriteOptions,
		): Promise<SnapshotRecord> {
			return (await writerStore()).snapshot(streamId, state, seq, opts);
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
			for (const pool of backupPools) await pool.end().catch(() => {});
		},
	};
}

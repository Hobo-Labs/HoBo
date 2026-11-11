import { randomUUID } from "node:crypto";
import {
	type AssignmentRegister,
	billingPeriod,
	bootstrapAssignment,
	createUsageMeter,
	ensureFleetControlTables,
	type FleetBackend,
	type FleetEvent,
	type FleetReconcileReport,
	type FleetReplicationResult,
	type FleetTransition,
	type PostgresFleetAssignment,
	type PostgresFleetDecision,
	readCurrentAssignment,
	reconcileFleet,
	sqlAssignmentRegister,
} from "@hobo/data-postgres";
import pg from "pg";
import type { RelayDatabase } from "./database-connections.js";
import {
	createFleetBudgetCheck,
	type DatabaseFleetBackend,
	type DatabaseFleetConfig,
	RELAY_FLEET_LAYOUT,
} from "./database-fleet-config.js";
import {
	DatabaseFenceError,
	meteredClient,
	pgExecutor,
} from "./database-fleet-executor.js";
import { createQueueWakeupHandler } from "./queue-forwarding.js";
import {
	prepareRelaySchema,
	RelaySchemaError,
	type RelaySchemaRole,
	relaySchemaState,
} from "./relay-schema.js";
import { createScheduledRepairHandler } from "./scheduled-repair.js";
import type { QueueMessage } from "./worker.js";

/** The relay application the fleet runs on whichever backend is the writer. */
export type FleetApplication = {
	handle(request: Request): Promise<Response>;
	tick(message: QueueMessage): Promise<void>;
	close(): Promise<void>;
};

type FenceStatus =
	| "writer"
	| "sealed"
	| "no-writer"
	| "undecided"
	| "no-majority"
	| "empty";

/** Every structured event the fleet logs. Ids, numbers and fixed tokens only:
 * never a connection string, a host name or an error message. */
type FleetLogRecord =
	| ({ event: "hobo_ci_database_fleet_replication" } & FleetReplicationResult)
	| ({ event: "hobo_ci_database_fleet_decision" } & PostgresFleetDecision)
	| ({ event: "hobo_ci_database_fleet_transition" } & FleetTransition)
	| {
			event: "hobo_ci_database_fleet_unsettled";
			status: "undecided" | "no-majority" | "empty";
			silent: readonly string[];
	  }
	| {
			event: "hobo_ci_database_fleet_fence";
			status: FenceStatus;
			epoch: number | undefined;
			active: string | undefined;
			target: string | undefined;
	  }
	| {
			event: "hobo_ci_database_fleet_application";
			status: "started";
			backend: string;
	  }
	| {
			event: "hobo_ci_database_fleet_schema";
			backend: string;
			role: RelaySchemaRole;
			/** `applied`: migrations ran. `ahead`: the backend records ones this
			 * release does not have, and was left alone. `refused`: a migration
			 * was rolled back. `failed`: the backend could not be asked. */
			status: "applied" | "ahead" | "refused" | "failed";
			scope: string | undefined;
			/** Migration ids: applied as `scope/id`, or the unknown ones. */
			migrations: readonly string[];
	  }
	| { event: "hobo_ci_database_fleet_failure"; stage: "reconcile" };

/** A failed logger changes nothing. */
function report(record: FleetLogRecord) {
	try {
		console.info(JSON.stringify(record));
	} catch {
		// Telemetry must never change what the fleet does.
	}
}

function reportFleetEvent(event: FleetEvent) {
	if (event.kind === "replication")
		report({
			event: "hobo_ci_database_fleet_replication",
			...event.replication,
		});
	else if (event.kind === "decision")
		report({ event: "hobo_ci_database_fleet_decision", ...event.decision });
	else if (event.kind === "transition")
		report({ event: "hobo_ci_database_fleet_transition", ...event.transition });
	else
		report({
			event: "hobo_ci_database_fleet_unsettled",
			status: event.status,
			silent: event.silent,
		});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run the relay on a fleet of databases: one writer at a time, chosen by the
 * assignment the backends hold, re-confirmed at least every lease.
 *
 * - An instance uses a backend only while the assignment it last confirmed by
 *   majority names that backend as writer, is not sealed, and is younger than
 *   the lease by this instance's wall clock. Every statement is checked, so an
 *   instance that was frozen and resumed cannot write on an old assignment.
 * - When the assignment is unknown, sealed or without a writer, requests get
 *   503 with `Retry-After`. `GET /readyz` says so in its body; `GET /healthz`
 *   still answers 200, because it reports on this process, not its database.
 * - When the writer changes, the old pools are closed and the application is
 *   built again on the new writer.
 * - A scheduled repair message first runs one reconcile tick, which copies the
 *   writer to the standbys and may move the writer. */
export function createDatabaseFleet(options: {
	env: NodeJS.ProcessEnv;
	config: DatabaseFleetConfig;
	/** Build the relay application on one database. */
	build(database: RelayDatabase): Promise<FleetApplication>;
	scheduledRepair(): Promise<void>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** The assignment register. Defaults to the backends' own log tables. */
	register?: AssignmentRegister;
}) {
	const { config } = options;
	const now = options.now ?? Date.now;
	const origin = new URL(options.env.HOBO_CI_PUBLIC_URL ?? "").origin;
	const cronSecret = options.env.CRON_SECRET;
	if (!cronSecret) throw new Error("missing configuration: CRON_SECRET");
	const meter = createUsageMeter();
	const instance = `relay:${randomUUID().slice(0, 8)}`;

	let lease:
		| { assignment: PostgresFleetAssignment; confirmedAtMs: number }
		| undefined;
	let status: FenceStatus | undefined;
	let lastAttemptMs = Number.NEGATIVE_INFINITY;
	let reportedEpoch: number | undefined;
	let flushedAtMs = now();

	/** May this instance send a statement to `backendId` right now? */
	const permits = (backendId: string) =>
		lease !== undefined &&
		!lease.assignment.sealed &&
		lease.assignment.active === backendId &&
		now() - lease.confirmedAtMs < config.leaseMs;

	// Control connections: one small session-scoped pool per backend, used for
	// the assignment log, copies and counters. Never fenced: a standby must be
	// reachable precisely when it is not the writer.
	const controlPools = new Map<string, pg.Pool>();
	const control: FleetBackend[] = config.backends.map((backend) => {
		const pool = new pg.Pool({
			...backend.database.direct,
			Client: meteredClient(() => meter.record(backend.id)),
			max: 2,
			connectionTimeoutMillis: 3000,
			idleTimeoutMillis: 10000,
		});
		// An idle connection to a backend that goes away must not crash the
		// process; the next statement reports the failure.
		pool.on("error", () => {});
		controlPools.set(backend.id, pool);
		return { id: backend.id, executor: pgExecutor(pool) };
	});
	const register =
		options.register ?? sqlAssignmentRegister(control, RELAY_FLEET_LAYOUT);

	/** The database settings the application gets: the backend's own, with a
	 * client that counts every statement and refuses one the fence forbids. */
	const fenced = (backend: DatabaseFleetBackend): RelayDatabase => {
		const Client = meteredClient((refusable) => {
			if (refusable && !permits(backend.id)) throw new DatabaseFenceError();
			meter.record(backend.id);
		});
		return {
			primary: { ...backend.database.primary, Client },
			direct: { ...backend.database.direct, Client },
		};
	};

	let refreshing: Promise<void> | undefined;
	/** Confirm the assignment by majority read. The lease is dated from before
	 * the read began, so it can only be shorter than the truth. */
	function refresh(): Promise<void> {
		refreshing ??= (async () => {
			const startedAt = now();
			lastAttemptMs = startedAt;
			try {
				let resolution = await readCurrentAssignment(register);
				if (resolution.status === "empty") {
					// A new fleet: the first configured backend is the writer.
					await Promise.all(
						control.map((backend) =>
							ensureFleetControlTables(backend, RELAY_FLEET_LAYOUT).catch(
								() => {},
							),
						),
					);
					const first = config.backends[0];
					if (first) await bootstrapAssignment(register, first.id);
					resolution = await readCurrentAssignment(register);
				}
				lease =
					resolution.status === "current"
						? { assignment: resolution.assignment, confirmedAtMs: startedAt }
						: undefined;
				const next: FenceStatus =
					resolution.status !== "current"
						? resolution.status
						: resolution.assignment.sealed
							? "sealed"
							: resolution.assignment.active === undefined
								? "no-writer"
								: "writer";
				if (
					next !== status ||
					(lease && lease.assignment.epoch !== reportedEpoch)
				) {
					status = next;
					reportedEpoch = lease?.assignment.epoch;
					report({
						event: "hobo_ci_database_fleet_fence",
						status: next,
						epoch: lease?.assignment.epoch,
						active: lease?.assignment.active,
						target: lease?.assignment.target,
					});
				}
			} catch {
				lease = undefined;
			} finally {
				refreshing = undefined;
			}
		})();
		return refreshing;
	}
	let running: { backendId: string; application: FleetApplication } | undefined;
	let building: Promise<FleetApplication | undefined> | undefined;

	async function drop() {
		const previous = running;
		running = undefined;
		if (!previous) return;
		// Statements on the old pools are already refused; do not wait for
		// stragglers longer than a moment.
		await Promise.race([
			previous.application.close().catch(() => {}),
			sleep(5000),
		]);
	}

	/** The application on the current writer, or nothing when the fence says
	 * nobody may write. */
	async function acquire(): Promise<FleetApplication | undefined> {
		const age = lease ? now() - lease.confirmedAtMs : Number.POSITIVE_INFINITY;
		// Renew at half a lease so a request that starts now can finish; after a
		// failed attempt wait a little instead of polling on every request.
		if (
			age >= config.leaseMs / 2 &&
			(lease !== undefined ||
				now() - lastAttemptMs >= Math.min(2000, config.leaseMs / 4))
		)
			await refresh();
		const assignment = lease?.assignment;
		if (!assignment || assignment.sealed || assignment.active === undefined)
			return undefined;
		if (running?.backendId === assignment.active) return running.application;
		building ??= (async () => {
			try {
				await drop();
				const backend = config.backends.find(
					(candidate) => candidate.id === assignment.active,
				);
				if (!backend) return undefined;
				const application = await options.build(fenced(backend));
				running = { backendId: backend.id, application };
				report({
					event: "hobo_ci_database_fleet_application",
					status: "started",
					backend: backend.id,
				});
				return application;
			} finally {
				building = undefined;
			}
		})();
		return building;
	}

	// While work is in flight the lease is renewed in the background, so a
	// long repair is not cut off at one lease, and is cut off within one lease
	// of the assignment moving away.
	let inFlight = 0;
	let renewal: ReturnType<typeof setInterval> | undefined;
	async function withLease<T>(work: () => Promise<T>): Promise<T> {
		inFlight += 1;
		renewal ??= setInterval(
			() => void refresh(),
			Math.max(250, Math.floor(config.leaseMs / 3)),
		);
		try {
			return await work();
		} finally {
			// Counters are written while the instance is certainly running: after
			// the response a serverless instance may be frozen for good.
			if (now() - flushedAtMs >= 60_000) {
				flushedAtMs = now();
				await meter
					.flush(
						control.filter((backend) => meter.pending(backend.id) > 0),
						RELAY_FLEET_LAYOUT,
						now(),
					)
					.catch(() => {});
			}
			inFlight -= 1;
			if (inFlight === 0 && renewal) {
				clearInterval(renewal);
				renewal = undefined;
			}
		}
	}

	const refusal = () => ({
		status: 503,
		headers: {
			"cache-control": "no-store",
			"retry-after": String(Math.max(1, Math.ceil(config.leaseMs / 1000))),
		},
	});
	const unavailable = () => new Response(null, refusal());

	/** The same refusal for a readiness probe, with a reason it can act on. */
	const notReady = () =>
		Response.json({ ready: false, reason: "store-unavailable" }, refusal());

	/** Backends this instance has seen holding every migration of this release. */
	const schemaCurrent = new Set<string>();
	/** The schema seam: bring one backend to this release's checked-in
	 * migrations, over its control connection, and say what happened. */
	async function prepareSchema(
		backendId: string,
		role: RelaySchemaRole,
	): Promise<void> {
		const pool = controlPools.get(backendId);
		if (!pool) throw new Error("unknown fleet backend");
		try {
			const { applied } = await prepareRelaySchema(pool, backendId, role);
			schemaCurrent.add(backendId);
			if (applied.length > 0)
				report({
					event: "hobo_ci_database_fleet_schema",
					backend: backendId,
					role,
					status: "applied",
					scope: undefined,
					migrations: applied,
				});
		} catch (error) {
			schemaCurrent.delete(backendId);
			const known = error instanceof RelaySchemaError ? error : undefined;
			report({
				event: "hobo_ci_database_fleet_schema",
				backend: backendId,
				role,
				status: known?.failure ?? "failed",
				scope: known?.scope,
				migrations: known?.migrations ?? [],
			});
			throw error;
		}
	}
	/** A copy only offers a standby to the seam when its columns differ from
	 * the writer's. A standby that lacks only an index would never be offered,
	 * so each standby's ledger is read once per instance (one statement) and a
	 * standby behind this release is migrated here. One that is ahead, or
	 * cannot be asked, is reported and asked again on the next tick. */
	async function prepareStandbys(
		assignment: PostgresFleetAssignment | undefined,
	): Promise<void> {
		if (!assignment || assignment.sealed) return;
		await Promise.all(
			control
				.filter(
					(backend) =>
						backend.id !== assignment.active && !schemaCurrent.has(backend.id),
				)
				.map(async (backend) => {
					const pool = controlPools.get(backend.id);
					if (!pool) return;
					try {
						if ((await relaySchemaState(pool)) === "current")
							schemaCurrent.add(backend.id);
						else await prepareSchema(backend.id, "standby");
					} catch {
						// Reported by the seam, or the backend is down, which the
						// tick's own probe has already said.
					}
				}),
		);
	}

	let reconciling: Promise<FleetReconcileReport | undefined> | undefined;
	/** One reconcile tick. A failure is reported and never stops the relay. */
	function reconcile(): Promise<FleetReconcileReport | undefined> {
		reconciling ??= (async () => {
			try {
				const models = config.backends.map((backend) => backend.model);
				const tick = await reconcileFleet({
					backends: control,
					layout: RELAY_FLEET_LAYOUT,
					models,
					policy: config.policy,
					leaseMs: config.leaseMs,
					graceMs: config.graceMs,
					ensureSchema: (backend, role) => prepareSchema(backend.id, role),
					checkBudget: (request) =>
						createFleetBudgetCheck({
							limitMicros: config.budgetLimitMicros,
							models,
							period: billingPeriod(request.nowMs),
						})(request),
					meter,
					limits: undefined,
					decidedBy: instance,
					now,
					sleep: options.sleep ?? sleep,
					log: reportFleetEvent,
				});
				await prepareStandbys(tick.assignment);
				return tick;
			} catch {
				report({ event: "hobo_ci_database_fleet_failure", stage: "reconcile" });
				return undefined;
			} finally {
				reconciling = undefined;
				// Whatever the tick did, confirm the assignment again before use.
				lease = undefined;
				lastAttemptMs = Number.NEGATIVE_INFINITY;
			}
		})();
		return reconciling;
	}

	async function tick(message: QueueMessage): Promise<void> {
		if (
			message !== null &&
			"source" in message &&
			message.source === "static" &&
			message.name === "hobo-ci-repair"
		)
			await reconcile();
		await withLease(async () => {
			const application = await acquire();
			if (!application) throw new Error("database assignment unavailable");
			await application.tick(message);
		});
	}

	// The two internal entry points are served here, not by the application,
	// so the schedule still reaches the reconciler when the writer is down.
	const queueWakeup = createQueueWakeupHandler({
		origin,
		secret: cronSecret,
		run: tick,
	});
	const scheduledRepair = createScheduledRepairHandler({
		secret: cronSecret,
		enqueue: options.scheduledRepair,
	});

	return {
		origin,
		tick,
		reconcile,
		/** The backend this instance's application is running on, if any. */
		writer: () => running?.backendId,
		/** The assignment this instance last confirmed, if it still holds. */
		assignment: () =>
			lease && now() - lease.confirmedAtMs < config.leaseMs
				? lease.assignment
				: undefined,
		async handle(request: Request): Promise<Response> {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/internal/queue-wakeup") return queueWakeup(request);
			if (pathname === "/internal/tick") return scheduledRepair(request);
			// Liveness is about this process. With no writer assigned the relay
			// is alive and waiting; restarting it would not find one.
			if (request.method === "GET" && pathname === "/healthz")
				return Response.json(
					{ ok: true },
					{ status: 200, headers: { "cache-control": "no-store" } },
				);
			const refuse =
				request.method === "GET" && pathname === "/readyz"
					? notReady
					: unavailable;
			return withLease(async () => {
				let application: FleetApplication | undefined;
				try {
					application = await acquire();
				} catch {
					return refuse();
				}
				if (!application) return refuse();
				const backendId = running?.backendId;
				try {
					const response = await application.handle(request);
					// A request the fence cut off mid-way did not complete.
					return response.status >= 500 &&
						(backendId === undefined || !permits(backendId))
						? refuse()
						: response;
				} catch (error) {
					if (
						error instanceof DatabaseFenceError ||
						backendId === undefined ||
						!permits(backendId)
					)
						return refuse();
					throw error;
				}
			});
		},
		async close() {
			if (renewal) clearInterval(renewal);
			renewal = undefined;
			await drop();
			await meter.flush(control, RELAY_FLEET_LAYOUT, now()).catch(() => {});
			for (const pool of controlPools.values())
				await pool.end().catch(() => {});
		},
	};
}

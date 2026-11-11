/**
 * The relay on a store it chose by itself.
 *
 * `selectStore` probes the attached stores and applies the rule in
 * `database-selection.ts`; `createSelectedRelay` runs the unchanged relay
 * application on the result. Selection runs once per function instance, when
 * the first request needs the application. It runs again only after it
 * failed, or after the chosen store refused a connection, and then no sooner
 * than the store back-off allows.
 */
import type { ReplicationLimits, SqlExecutor } from "@hobo/data-postgres";
import pg from "pg";
import { StoreUnavailable, storeBackoffMs } from "./bootstrap-entry.js";
import type { RelayDatabase } from "./database-connections.js";
import {
	type DiscoveredDatabase,
	discoverDatabases,
} from "./database-discovery.js";
import type { FleetApplication } from "./database-fleet.js";
import { environmentConnection } from "./database-fleet-config.js";
import { pgExecutor } from "./database-fleet-executor.js";
import {
	chooseStore,
	classifyStoreFailure,
	type SelectionReason,
	type StoreObservation,
} from "./database-selection.js";
import {
	type ImportOutcome,
	importRelayData,
	NOT_PRISTINE,
	storeHoldsRegistration,
} from "./database-selection-import.js";
import {
	promoteStore,
	readStoreMarker,
	type StoreMarker,
} from "./database-selection-marker.js";
import { createQueueWakeupHandler } from "./queue-forwarding.js";
import type { QueueMessage } from "./worker.js";

/** A discovered database the relay could run on: both of its connections
 * resolve, and the session-scoped one is not a known pooler. */
export type SelectableStore = DiscoveredDatabase & {
	connection: RelayDatabase;
};

/**
 * The attached databases the relay may choose between, in discovery order.
 * A database without a usable session-scoped connection is left out: the
 * relay cannot run repair on it. That is decided from the environment alone,
 * so every instance of a deployment leaves out the same ones.
 *
 * A store under a prefix takes its certificate authority from
 * `<PREFIX>HOBO_CI_DATABASE_CA_CERT`, the unprefixed one from
 * `HOBO_CI_DATABASE_CA_CERT`: one provider's private root is never imposed
 * on another provider's store.
 */
export function selectableStores(env: NodeJS.ProcessEnv): SelectableStore[] {
	const stores: SelectableStore[] = [];
	for (const candidate of discoverDatabases(env)) {
		try {
			stores.push({
				...candidate,
				connection: environmentConnection(env, candidate.prefix),
			});
		} catch {
			// Not a store the relay can run on; discovery already listed it.
		}
	}
	return stores;
}

type CandidateReport = {
	prefix: string;
	database: string;
	class: StoreObservation["class"];
	generation?: number;
	sqlstate?: string;
	code?: string;
};

type UndecidedCause = "unclassified-candidate" | "no-serving-candidate";

/** Every line selection logs. Variable-name prefixes, database digests,
 * numbers and fixed tokens only: never a connection string, a host name or
 * an error message. */
export type SelectionLogRecord =
	| {
			event: "hobo_ci_database_selected";
			prefix: string;
			binding: DiscoveredDatabase["binding"];
			database: string;
			generation: number;
			reason: SelectionReason;
			candidates: CandidateReport[];
	  }
	| {
			event: "hobo_ci_database_selection_undecided";
			cause: UndecidedCause;
			candidates: CandidateReport[];
	  }
	| ({
			event: "hobo_ci_database_import";
			/** Digest of the store read from. */
			source: string;
			/** Digest of the store written to. */
			target: string;
	  } & (ImportOutcome | { status: "failed"; code: string | undefined }));

/** A failed logger changes nothing. */
function report(record: SelectionLogRecord) {
	try {
		console.info(JSON.stringify(record));
	} catch {
		// Telemetry must never change which store is chosen.
	}
}

function describe(
	store: SelectableStore,
	observation: StoreObservation,
): CandidateReport {
	const entry: CandidateReport = {
		prefix: store.prefix,
		database: store.database,
		class: observation.class,
	};
	if (observation.class === "serving")
		entry.generation = observation.generation;
	else if (observation.class === "refusing")
		entry.sqlstate = observation.sqlstate;
	else if (observation.code !== undefined) entry.code = observation.code;
	return entry;
}

function failureOf(error: Error | undefined) {
	const failure = classifyStoreFailure(error);
	return failure.class === "refusing" ? failure.sqlstate : failure.code;
}

/** Selection could not name a store. The relay reports its store as
 * unavailable and asks again later. */
export class StoreSelectionUndecided extends Error {
	constructor(readonly reason: UndecidedCause) {
		super("no store could be selected");
		this.name = "StoreSelectionUndecided";
	}
}

export type SelectedStore = {
	store: SelectableStore;
	generation: number;
	reason: SelectionReason;
};

export type SelectionOptions = {
	/** Bound on connecting to a candidate and on each statement of its probe. */
	probeTimeoutMs?: number;
	/** Overrides for `STORE_IMPORT_LIMITS`. */
	importLimits?: Partial<ReplicationLimits>;
	log?: (record: SelectionLogRecord) => void;
};

type Probed =
	| { class: "serving"; marker: StoreMarker }
	| Exclude<StoreObservation, { class: "serving" }>;

type Candidate = {
	store: SelectableStore;
	pool: pg.Pool;
	executor: SqlExecutor;
};

/**
 * Import into the chosen store from the newest older store that holds a
 * registration, and say what happened. Says nothing when no older store holds
 * one. Never throws: the relay runs on the chosen store whatever happens here.
 */
async function carryOver(
	chosen: Candidate,
	older: readonly Candidate[],
	limits: Partial<ReplicationLimits> | undefined,
	log: (record: SelectionLogRecord) => void,
): Promise<void> {
	for (const candidate of older) {
		const sides = {
			source: candidate.store.database,
			target: chosen.store.database,
		};
		try {
			if (!(await storeHoldsRegistration(candidate.executor))) continue;
			// Asked first on the connection already open, so a chosen store
			// that is in use costs two statements and no schema work. The
			// import asks again inside its transaction, and that decides.
			const outcome: ImportOutcome = (await storeHoldsRegistration(
				chosen.executor,
			))
				? NOT_PRISTINE
				: await importRelayData({
						source: {
							database: candidate.store.database,
							settings: candidate.store.connection.direct,
						},
						target: {
							database: chosen.store.database,
							settings: chosen.store.connection.direct,
						},
						limits,
					});
			log({ event: "hobo_ci_database_import", ...sides, ...outcome });
		} catch (error) {
			log({
				event: "hobo_ci_database_import",
				...sides,
				status: "failed",
				code: failureOf(error instanceof Error ? error : undefined),
			});
		}
		return;
	}
}

/**
 * Probe every candidate, choose, write the generation if one is due, and
 * carry the old store's data over if the chosen store has none.
 *
 * Throws `StoreSelectionUndecided` when no store can be named, and whatever
 * the chosen store threw if writing its generation failed. A failed import
 * never fails selection: the relay runs on the chosen store either way, and
 * the import is tried again by the next instance that starts.
 */
export async function selectStore(
	stores: readonly SelectableStore[],
	options: SelectionOptions = {},
): Promise<SelectedStore> {
	const log = options.log ?? report;
	const timeout = options.probeTimeoutMs ?? 5000;
	const candidates = stores.map((store) => {
		// One short attempt on the session-scoped connection: the connection
		// repair needs, and the one a pooler cannot answer for.
		const pool = new pg.Pool({
			...store.connection.direct,
			max: 1,
			connectionTimeoutMillis: timeout,
			query_timeout: timeout,
			idleTimeoutMillis: 1000,
		});
		// A candidate going away mid-probe must not take the process down.
		pool.on("error", () => {});
		return { store, pool, executor: pgExecutor(pool) };
	});
	try {
		const probed = await Promise.all(
			candidates.map(async (candidate): Promise<Probed> => {
				try {
					return {
						class: "serving",
						marker: await readStoreMarker(candidate.executor),
					};
				} catch (error) {
					return classifyStoreFailure(
						error instanceof Error ? error : undefined,
					);
				}
			}),
		);
		const observations = probed.map(
			(entry): StoreObservation =>
				entry.class === "serving"
					? { class: "serving", generation: entry.marker.generation }
					: entry,
		);
		const described = candidates.flatMap((candidate, index) => {
			const observation = observations[index];
			return observation ? [describe(candidate.store, observation)] : [];
		});
		const choice = chooseStore(observations);
		if (choice.status === "undecided") {
			log({
				event: "hobo_ci_database_selection_undecided",
				cause: choice.cause,
				candidates: described,
			});
			throw new StoreSelectionUndecided(choice.cause);
		}
		const chosen = candidates[choice.index];
		const held = probed[choice.index];
		if (!chosen || held?.class !== "serving")
			throw new Error("selection chose no candidate");
		const generation = choice.promote
			? await promoteStore(chosen.executor, choice)
			: choice.held;
		log({
			event: "hobo_ci_database_selected",
			prefix: chosen.store.prefix,
			binding: chosen.store.binding,
			database: chosen.store.database,
			generation,
			reason: choice.reason,
			candidates: described,
		});
		// The stores the relay left: answering again and older than the chosen
		// one, newest first.
		const older = candidates
			.flatMap((candidate, index) => {
				const entry = probed[index];
				return candidate !== chosen &&
					entry?.class === "serving" &&
					entry.marker.generation < generation
					? [{ candidate, generation: entry.marker.generation }]
					: [];
			})
			.sort((left, right) => right.generation - left.generation)
			.map((entry) => entry.candidate);
		if (!held.marker.imported)
			await carryOver(chosen, older, options.importLimits, log);
		return { store: chosen.store, generation, reason: choice.reason };
	} finally {
		await Promise.all(
			candidates.map((candidate) => candidate.pool.end().catch(() => {})),
		);
	}
}

/**
 * A `pg` client class that says when the server refused a connection with one
 * of `STORE_REFUSAL_SQLSTATES`, and when it accepted one. The relay's pools
 * are built with it, so a store that starts refusing after it was chosen is
 * noticed wherever the failed connection was asked for.
 */
export function refusalObservingClient(
	onRefusal: (sqlstate: string) => void,
	onConnected: () => void = () => {},
): typeof pg.Client {
	const failed = (error: Error | undefined) => {
		const failure = classifyStoreFailure(error);
		if (failure.class === "refusing") onRefusal(failure.sqlstate);
	};
	return class RefusalObservingClient extends pg.Client {
		override connect(): Promise<void>;
		override connect(callback: (error: Error) => void): void;
		override connect(
			callback?: (error: Error) => void,
		): Promise<void> | undefined {
			if (callback) {
				super.connect((error) => {
					if (error) failed(error);
					else onConnected();
					callback(error);
				});
				return undefined;
			}
			return super.connect().then(onConnected, (error) => {
				failed(error instanceof Error ? error : undefined);
				throw error;
			});
		}
	};
}

type Running = { application: FleetApplication; refused: boolean };

/** Close an application whose store refused it, without waiting for
 * stragglers longer than a moment. */
async function closeWithin(application: FleetApplication, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			application.close().catch(() => {}),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Run the relay on the store selection names.
 *
 * - Nothing is probed until a request needs the application. `GET /healthz`
 *   never waits for a store: it reports on this process.
 * - While no store can be named (a candidate is `unknown`, or none serves),
 *   the store is reported unavailable exactly as a single store that is down
 *   is: `GET /readyz` answers 503 `store-unavailable`, anything else fails
 *   with `StoreUnavailable`, and selection is left alone for the same
 *   back-off, 5 s doubling to a minute.
 * - When the chosen store later refuses a connection, the application built
 *   on it is closed and selection runs again on the next request after the
 *   back-off. A store that refused once and answers the new probe is simply
 *   chosen again.
 */
export function createSelectedRelay(options: {
	env: NodeJS.ProcessEnv;
	stores: readonly SelectableStore[];
	/** Build the relay application on one database. */
	build(database: RelayDatabase): Promise<FleetApplication>;
	select?: (stores: readonly SelectableStore[]) => Promise<SelectedStore>;
	/** Clock for the back-off; injectable for tests. */
	now?: () => number;
}) {
	const origin = new URL(options.env.HOBO_CI_PUBLIC_URL ?? "").origin;
	const clock = options.now ?? Date.now;
	const select = options.select ?? ((stores) => selectStore(stores));
	let running: Running | undefined;
	let starting: Promise<FleetApplication> | undefined;
	let retryAt = 0;
	let failures = 0;
	let closed = false;
	const failed = () => {
		failures += 1;
		retryAt = clock() + storeBackoffMs(failures);
	};

	async function start(): Promise<FleetApplication> {
		const previous = running;
		running = undefined;
		if (previous) await closeWithin(previous.application, 5000);
		const selected = await select(options.stores);
		const { primary, direct } = selected.store.connection;
		let started: Running | undefined;
		const Client = refusalObservingClient(
			() => {
				// A refusal while the application is still being built fails
				// the build, which is counted there.
				if (!started || started.refused || running !== started) return;
				started.refused = true;
				failed();
			},
			() => {
				// The back-off starts over when the chosen store accepts a
				// connection. Building the application proves nothing: in
				// bootstrap mode it dials no one.
				if (started && running === started && !started.refused) failures = 0;
			},
		);
		const application = await options.build({
			primary: { ...primary, Client },
			direct: { ...direct, Client },
		});
		if (closed) {
			await application.close();
			throw new Error("relay closed");
		}
		started = { application, refused: false };
		running = started;
		return application;
	}

	function application(): Promise<FleetApplication> {
		if (closed) return Promise.reject(new Error("relay closed"));
		if (running && !running.refused)
			return Promise.resolve(running.application);
		if (!starting && clock() < retryAt)
			return Promise.reject(new StoreUnavailable(retryAt - clock()));
		starting ??= start()
			.catch((error) => {
				failed();
				// No store could be named: that is an unavailable store, and the
				// rest of the relay already knows what to do with one.
				throw error instanceof StoreSelectionUndecided
					? new StoreUnavailable(retryAt - clock())
					: error;
			})
			.finally(() => {
				starting = undefined;
			});
		return starting;
	}

	async function tick(message: QueueMessage): Promise<void> {
		await (await application()).tick(message);
	}
	// Served here for the same reason the bootstrap entry serves it: with no
	// store chosen there is no application to hand the wakeup to.
	const cronSecret = options.env.CRON_SECRET;
	const queueWakeup = cronSecret
		? createQueueWakeupHandler({ origin, secret: cronSecret, run: tick })
		: undefined;
	return {
		origin,
		async handle(request: Request): Promise<Response> {
			if (
				queueWakeup &&
				new URL(request.url).pathname === "/internal/queue-wakeup"
			)
				return queueWakeup(request);
			const probe =
				request.method === "GET" ? new URL(request.url).pathname : "";
			// Liveness is about this process, not its stores: a probe must be
			// able to tell "restart me" from "no store answers".
			if (probe === "/healthz" && (!running || running.refused))
				return Response.json(
					{ ok: true },
					{ status: 200, headers: { "cache-control": "no-store" } },
				);
			let current: FleetApplication;
			try {
				current = await application();
			} catch (error) {
				if (probe === "/readyz")
					return Response.json(
						{ ready: false, reason: "store-unavailable" },
						{
							status: 503,
							headers: { "cache-control": "no-store", "retry-after": "5" },
						},
					);
				throw error;
			}
			return current.handle(request);
		},
		tick,
		async close(): Promise<void> {
			closed = true;
			await starting?.catch(() => {});
			await running?.application.close();
		},
	};
}

/**
 * The PostgreSQL engine binding: the `@hobo/data-core` SPI over an injected
 * executor.
 *
 * Nothing here knows how the server is reached. The binding is handed a
 * `PostgresExecutor` and turns each port into SQL: datasets are real typed
 * tables, the write fence is a trigger the store itself enforces, capture is
 * logical decoding, and the digest is the canonical one computed over rows
 * read back through the same normalisation a record read uses.
 */
import {
	type Awaitable,
	type EngineBinding,
	type EngineDeclaration,
	type InPlaceEvolvePlan,
	parseEngineDeclaration,
	type SchemaFixture,
	type SchemaSnapshotRef,
	type SpiPortName,
} from "@hobo/data-core";
import { POSTGRES_PROFILE_ID } from "../authoring.js";
import { PostgresDataError } from "../errors.js";
import { LOGICAL_COPY_PROFILE } from "../migration-profiles.js";
import { createCapturePort } from "./capture.js";
import type { PostgresExecutor } from "./executor.js";
import { parseNamespace, parseTableName } from "./identifiers.js";
import { createNativeTransferPort } from "./native.js";
import { createSchemaPort } from "./schema-port.js";
import { DatasetStore } from "./store.js";
import { POSTGRES_ENGINE_ID, POSTGRES_TYPE_MAPPING } from "./types.js";

/**
 * Impedance this engine can report (ADR-0144). Each is a real limit of the
 * engine or of this binding, stated so nobody over-claims fidelity.
 */
export const POSTGRES_IMPEDANCE_CODES = [
	/** `tenant_id` and `hobo_extra` are columns of every dataset table; a field may not take either name. */
	"POSTGRES_RESERVED_COLUMN_NAMES",
	/** `text` cannot hold U+0000 or an unpaired surrogate; such a string is refused at write. */
	"POSTGRES_TEXT_REFUSES_NUL_AND_LONE_SURROGATES",
	/** `jsonb` keeps numbers at arbitrary precision: a natively written number float64 cannot hold exactly reads as the nearest float64, and one beyond float64's range is refused on read. */
	"POSTGRES_JSONB_NUMBERS_READ_AS_FLOAT64",
	/** NaN, the infinities, BC and five-digit years exist natively and have no canonical form; reading one is refused. */
	"POSTGRES_NATIVE_VALUES_BEYOND_CANONICAL_RANGE",
	/** The snapshot scan is keyset pagination, not one MVCC snapshot. */
	"POSTGRES_SNAPSHOT_IS_FUZZY",
	/**
	 * The fence is a trigger that runs with its owner's rights and a pinned search path, over metadata tables no other role is granted.
	 * What can still get past it: the table's owner or a superuser, who can disable the trigger, read a token from the fence table, or delete the fence row;
	 * and any role the owner has since granted the fence table to. The token is kept there in the clear so that raising a raised fence can answer it.
	 * A writer that holds a transaction open after writing keeps `raise` waiting until it ends.
	 */
	"POSTGRES_FENCE_TRIGGER_OWNER_CAN_DISABLE",
	/** TRUNCATE is refused on dataset tables; it names no keys, so it could be neither fenced per tenant nor captured. */
	"POSTGRES_TRUNCATE_REFUSED_ON_DATASETS",
	/** Capture needs `wal_level = logical`, the REPLICATION privilege, and one replication slot per subscription. */
	"POSTGRES_CAPTURE_NEEDS_LOGICAL_DECODING",
	/** A subscription pins the log from its last acknowledged position until it is stopped. */
	"POSTGRES_CAPTURE_SLOT_PINS_LOG",
	/** A read returns whole transactions, so one transaction larger than the limit is returned whole. */
	"POSTGRES_CAPTURE_WHOLE_TRANSACTIONS",
	/** An update that leaves a large out-of-line value untouched is completed by re-reading the row, which may be newer than the change. */
	"POSTGRES_CAPTURE_UNCHANGED_TOAST_REREAD",
	/** A slot is not carried to a standby: after a failover the subscription is lost, and reads say so. */
	"POSTGRES_CAPTURE_SLOT_NOT_FAILOVER_SAFE",
	/** A schema snapshot is a table copy inside the same database: it costs space and time in proportion to the data. */
	"POSTGRES_SCHEMA_SNAPSHOT_IS_A_COPY",
	/** Tables with foreign keys, triggers, sequences, row security, grants, partitions or inheritance are refused by the snapshot. */
	"POSTGRES_SCHEMA_SNAPSHOT_REFUSES_DEPENDENT_OBJECTS",
	/** A restored table is a new relation: index and key constraint names are regenerated, and its object id changes. */
	"POSTGRES_SCHEMA_RESTORE_RECREATES_TABLE",
	/** `retire` deletes rows, and the log records them as deletes: any subscription still reading the dataset captures them. Executors drop a migration's own forward channel before retiring. */
	"POSTGRES_RETIRE_IS_LOGGED_AS_DELETES",
	/** Logical-copy moves a whole dataset table, into an empty table of the same schema-qualified name in another database. One tenant of a pooled table, a rename, or a merge is refused. */
	"POSTGRES_NATIVE_COPY_WHOLE_DATASET_SAME_NAME",
	/** Logical-copy carries no reverse tail: the transfer is dropped at cutover, so a rollback from soak is to-snapshot. */
	"POSTGRES_NATIVE_COPY_NO_REVERSE_TAIL",
	/** The target server keeps the source connection string in `pg_subscription` until cutover drops the subscription; its superusers can read it. */
	"POSTGRES_NATIVE_COPY_TARGET_HOLDS_SOURCE_CONNECTION",
	/** Logical-copy needs `wal_level = logical`, a free replication slot and sender on the source, a free worker on the target, and a target role allowed to create subscriptions. */
	"POSTGRES_NATIVE_COPY_NEEDS_REPLICATION_CAPACITY",
	/**
	 * The connection string reaches the target server as a bind parameter, and a server that logs statements logs their parameters.
	 * The subscribing transaction turns that logging off for itself first (`log_parameter_max_length`, `log_statement`, the duration thresholds), which needs a superuser or, from PostgreSQL 15, `SET ON PARAMETER`.
	 * A role that may not, on a server that logs statements, is refused (`CONNECTION_WOULD_BE_LOGGED`) rather than logged. An extension that logs parameters by its own settings — pgaudit — is outside what this can see.
	 */
	"POSTGRES_NATIVE_COPY_REFUSED_WHERE_CONNECTION_WOULD_BE_LOGGED",
] as const;

export type PostgresImpedanceCode = (typeof POSTGRES_IMPEDANCE_CODES)[number];

const ALL_PORTS: readonly SpiPortName[] = [
	"datasets",
	"records",
	"snapshot",
	"capture",
	"apply",
	"verify",
	"fence",
	"retire",
	"schema",
];

// domain-view: parsed options; wire form is PostgresEngineOptions in data-models/postgres_engine.proto.
export interface PostgresEngineOptions {
	/** How the server is reached. The binding never closes it. */
	readonly executor: PostgresExecutor;
	/** Server-side schema holding the dataset tables. Defaults to `public`. */
	readonly namespace?: string;
	/**
	 * False omits the capture port, for a product where logical decoding is
	 * unavailable. The declaration then says so, and the patterns that need
	 * capture become ineligible instead of failing at run time.
	 */
	readonly capture?: boolean;
	/** Tables in the namespace the schema port snapshots and restores. */
	readonly schemaTables?: readonly string[];
	/** Rows per keyset page when digesting. Defaults to 1000. */
	readonly pageSize?: number;
	/**
	 * True makes `close()` drop everything the namespace holds: its
	 * subscriptions and their replication slots, its schema snapshots, and the
	 * namespace itself. For throwaway stores — a test, a preview. The default
	 * keeps all of it: a subscription is durable and outlives the binding
	 * until `capture.stop`.
	 */
	readonly ephemeral?: boolean;
	/** Injected instant for snapshot references. */
	readonly clock?: () => string;
	/**
	 * How the *target server* reaches the source, for a native logical-copy:
	 * a libpq connection string, resolved when a subscription is created. It
	 * is a secret. Give it as a function so it is fetched from where secrets
	 * are kept, at the moment it is needed; the binding sends it to the server
	 * as one bind parameter and puts it nowhere else. Only a binding that is
	 * the target of a native transfer needs it.
	 */
	readonly nativeSourceConnection?: () => Awaitable<string>;
	/** How long a native progress question waits before answering "not yet". Defaults to 50 ms. */
	readonly nativePollIntervalMs?: number;
	/** Injected wait, so a test does not sleep. Defaults to a timer. */
	readonly nativeWait?: (milliseconds: number) => Promise<void>;
}

export interface PostgresEngine extends EngineBinding {
	readonly namespace: string;
	/** Drop one schema snapshot's copy; snapshots are kept until dropped. */
	dropSchemaSnapshot(ref: SchemaSnapshotRef): Promise<void>;
}

/** The declaration a binding with these ports publishes. */
export function postgresEngineDeclaration(
	options: { readonly capture?: boolean } = {},
): EngineDeclaration {
	const capture = options.capture ?? true;
	return parseEngineDeclaration({
		engine: POSTGRES_ENGINE_ID,
		profile: POSTGRES_PROFILE_ID,
		paradigm: "relational",
		ports: ALL_PORTS.filter((port) => capture || port !== "capture"),
		captureOrdering: capture ? "global" : "none",
		fenceEnforcement: "store",
		snapshotConsistency: "fuzzy",
		ddlTransactional: true,
		// Only what the binding's `nativeTransfer` port can run is declared:
		// a declared fast path is one the selector may choose and an executor
		// must then be able to carry out. Logical-copy is logical replication,
		// so without logical decoding it is not on offer. `pg_dump` is not
		// declared at all: running it takes a process runner this package does
		// not have, so it stays a migration profile with argv builders (see
		// `migration-profiles.ts`) and is never offered as a native candidate.
		nativeProfiles: capture
			? [{ profile: LOGICAL_COPY_PROFILE, pattern: "snapshot-and-tail" }]
			: [],
		typeMapping: POSTGRES_TYPE_MAPPING,
		impedance: [...POSTGRES_IMPEDANCE_CODES],
	});
}

function parsePageSize(value: number | undefined): number {
	const size = value ?? 1000;
	if (!Number.isInteger(size) || size < 1 || size > 100_000) {
		throw new PostgresDataError(
			"ENGINE_OPTIONS_INVALID",
			"pageSize must be an integer from 1 to 100000",
			{ detail: { field: "pageSize" } },
		);
	}
	return size;
}

function parsePollInterval(value: number | undefined): number {
	const interval = value ?? 50;
	if (!Number.isInteger(interval) || interval < 0 || interval > 60_000) {
		throw new PostgresDataError(
			"ENGINE_OPTIONS_INVALID",
			"nativePollIntervalMs must be an integer from 0 to 60000",
			{ detail: { field: "nativePollIntervalMs" } },
		);
	}
	return interval;
}

function timer(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function parseChunkSize(value: number): number {
	if (!Number.isInteger(value) || value < 1) {
		throw new PostgresDataError(
			"ENGINE_OPTIONS_INVALID",
			"chunkSize must be a positive integer",
			{ detail: { field: "chunkSize" } },
		);
	}
	return value;
}

export function createPostgresEngine(
	options: PostgresEngineOptions,
): PostgresEngine {
	const namespace = parseNamespace(options.namespace ?? "public");
	const captureEnabled = options.capture ?? true;
	if (options.ephemeral === true && namespace === "public") {
		throw new PostgresDataError(
			"ENGINE_OPTIONS_INVALID",
			"an ephemeral binding drops its namespace on close, so it needs a namespace of its own, not public",
			{ detail: { field: "ephemeral" } },
		);
	}
	const clock = options.clock ?? (() => new Date().toISOString());
	const store = new DatasetStore({
		executor: options.executor,
		namespace,
		pageSize: parsePageSize(options.pageSize),
	});
	// The capture machinery exists either way, so an ephemeral close can
	// clean up subscriptions an earlier binding left in this namespace.
	const pollIntervalMs = parsePollInterval(options.nativePollIntervalMs);
	const wait = options.nativeWait ?? timer;
	const capture = createCapturePort(store, { pollIntervalMs, wait });
	const schema = createSchemaPort({
		store,
		tables: (options.schemaTables ?? []).map(parseTableName),
		clock,
	});
	// Like capture, the native machinery exists either way, so an ephemeral
	// close can drop what an earlier binding left behind.
	const native = createNativeTransferPort({
		store,
		capture,
		sourceConnection: options.nativeSourceConnection,
		pollIntervalMs,
		wait,
	});

	const binding: PostgresEngine = {
		namespace,
		declaration: postgresEngineDeclaration({ capture: captureEnabled }),
		datasets: {
			async ensureDataset(datasetSchema) {
				return {
					dataset: datasetSchema.name,
					created: await store.ensure(datasetSchema),
				};
			},
			describeDataset: (name) => store.describe(name),
		},
		records: {
			async write(request) {
				await store.write(
					request.dataset,
					request.mutations,
					request.fenceToken,
				);
				return { applied: request.mutations.length };
			},
			read: (request) =>
				store.read(request.dataset, request.tenant, request.key),
		},
		snapshot: {
			async openSnapshot(request) {
				const stored = await store.dataset(request.scope.dataset);
				return {
					next: store.openScan(
						stored,
						request.scope.tenant,
						parseChunkSize(request.chunkSize),
					),
					async close() {},
				};
			},
		},
		...(captureEnabled
			? {
					capture: {
						start: capture.start,
						read: capture.read,
						acknowledge: capture.acknowledge,
						stop: capture.stop,
					},
				}
			: undefined),
		apply: {
			async apply(request) {
				await store.apply(
					request.dataset,
					request.changes,
					request.source,
					request.position,
					request.fenceToken,
					request.expectedWatermark,
				);
				return { applied: request.changes.length };
			},
			watermark: (request) => store.watermark(request.dataset, request.source),
		},
		verify: {
			digest: (request) => store.digest(request.scope, request.buckets),
		},
		fence: {
			async raise(request) {
				return {
					fenceToken: await store.raiseFence(request.scope, request.reason),
				};
			},
			release: (request) =>
				store.releaseFence(request.scope, request.fenceToken),
			async status(scope) {
				return { fenced: await store.isFenced(scope) };
			},
		},
		retire: {
			async retire(request) {
				return {
					removed: await store.retire(
						request.scope,
						request.fenceToken,
						request.expected,
					),
				};
			},
		},
		schema: {
			snapshot: schema.snapshot,
			applyPhase: schema.applyPhase,
			verify: schema.verify,
			restore: schema.restore,
		},
		...(captureEnabled
			? {
					nativeTransfer: {
						profiles: native.profiles,
						publish: native.publish,
						subscribe: native.subscribe,
						seeded: native.seeded,
						mark: native.mark,
						reached: native.reached,
						pause: native.pause,
						resume: native.resume,
						stop: native.stop,
					},
				}
			: undefined),
		dropSchemaSnapshot: schema.dropSnapshot,
		async close() {
			// A binding that never reached the server has nothing to drop.
			if (options.ephemeral !== true || !store.touched) return;
			// Native transfers first: a subscription still attached holds its
			// slot, which the capture sweep below would then fail to drop.
			await native.stopAll();
			await capture.stopAll();
			await schema.dropAllSnapshots();
			await store.dropNamespace();
		},
	};
	return Object.freeze(binding);
}

// ── conformance fixture ─────────────────────────────────────────────────────

// public-contract: table the conformance schema fixture evolves; pass it as schemaTables.
export const POSTGRES_SCHEMA_FIXTURE_TABLE = "hobo_evolve_accounts";

const FIXTURE_PLAN: InPlaceEvolvePlan = Object.freeze({
	migrationId: "postgres-conformance",
	expand: [
		`ALTER TABLE ${POSTGRES_SCHEMA_FIXTURE_TABLE} ADD COLUMN contact_ref text`,
	],
	backfill: [
		`UPDATE ${POSTGRES_SCHEMA_FIXTURE_TABLE} SET contact_ref = 'ref:' || id::text WHERE contact_ref IS NULL`,
	],
	contract: [`ALTER TABLE ${POSTGRES_SCHEMA_FIXTURE_TABLE} DROP COLUMN email`],
	verify: {
		afterBackfill: `SELECT id FROM ${POSTGRES_SCHEMA_FIXTURE_TABLE} WHERE contact_ref IS NULL`,
		afterContract: `SELECT id FROM ${POSTGRES_SCHEMA_FIXTURE_TABLE} WHERE contact_ref IS NULL`,
	},
});

/**
 * Real DDL the conformance kit drives `in-place-evolve` with. Names are
 * unqualified: the schema port resolves them in the binding's namespace.
 */
export const POSTGRES_SCHEMA_FIXTURE: SchemaFixture = Object.freeze({
	setup: [
		`CREATE TABLE ${POSTGRES_SCHEMA_FIXTURE_TABLE} (id bigint PRIMARY KEY, email text NOT NULL)`,
		`INSERT INTO ${POSTGRES_SCHEMA_FIXTURE_TABLE} (id, email) VALUES (1, 'a@example.test'), (2, 'b@example.test')`,
	],
	plan: FIXTURE_PLAN,
	provesContractApplied: `SELECT 1 AS applied WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${POSTGRES_SCHEMA_FIXTURE_TABLE}' AND column_name = 'email')`,
	failingStatement: `ALTER TABLE ${POSTGRES_SCHEMA_FIXTURE_TABLE} DROP COLUMN no_such_column`,
	// Two statements with separate effects, for the probes that put more than
	// one statement where one belongs. Unqualified, like the rest.
	probes: {
		first: `CREATE TABLE ${POSTGRES_SCHEMA_FIXTURE_TABLE}_probe_first (id bigint PRIMARY KEY)`,
		second: `CREATE TABLE ${POSTGRES_SCHEMA_FIXTURE_TABLE}_probe_second (id bigint PRIMARY KEY)`,
		provesFirst: `SELECT table_name::text AS present FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '${POSTGRES_SCHEMA_FIXTURE_TABLE}_probe_first'`,
		provesSecond: `SELECT table_name::text AS present FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '${POSTGRES_SCHEMA_FIXTURE_TABLE}_probe_second'`,
	},
});

/**
 * The reusable `data.postgres/v1` conformance suite.
 *
 * A product advertises a set of structured capabilities; this suite is how it
 * *proves the subset it advertises*. The design has three properties that make
 * it usable in the default offline lane:
 *
 * - **Cases are pure data.** No case holds a connection, a clock, or a
 *   template that gets string-concatenated at runtime. A suite can be printed,
 *   diffed, and hashed into a conformance reference.
 * - **Executors are injected.** Running a case means handing it to a
 *   {@link PostgresConformanceExecutors} implementation. The unit lane injects
 *   a deterministic fake; a release lane injects one that opens a real session.
 * - **It fails closed.** An applicable case with no executor is `not-run`, and
 *   a report containing a single `not-run` is `unknown`, never `pass`. That is
 *   the difference between "we did not check" and "it works".
 *
 * A case only applies when the product advertises the capability it proves. A
 * product that never claims `extensions` is not marked failing for pgvector; it
 * is simply not asked, and its `extensions` gate fails on absence instead.
 */
import {
	type PostgresStructuredCapabilities,
	postgresCapability,
} from "./capabilities.js";
import { PostgresDataError } from "./errors.js";

// public-contract: stable conformance-suite reference used by provider evidence.
export const POSTGRES_CONFORMANCE_SUITE_REF =
	"conformance.data.postgres/v1" as const;

/** Which injected executor a case needs. */
export const POSTGRES_CONFORMANCE_EXECUTORS = [
	"sql",
	"binding",
	"process",
	"static",
] as const;

export type PostgresConformanceExecutorKind =
	(typeof POSTGRES_CONFORMANCE_EXECUTORS)[number];

/**
 * The condition under which a case applies.
 *
 * `present` is deliberately distinct from `equals true`: `extensions` is a
 * string set, and the question is whether the product advertised one at all.
 */
export type PostgresConformancePrecondition =
	| {
			readonly operator: "equals";
			readonly key: string;
			readonly value: boolean | number | string;
	  }
	| { readonly operator: "present"; readonly key: string }
	| {
			readonly operator: "includes";
			readonly key: string;
			readonly value: string;
	  };

export type PostgresConformanceCheck =
	| {
			readonly kind: "sql";
			/** Statements the executor runs in order, verbatim. */
			readonly statements: readonly string[];
			readonly expect: "all-succeed" | "last-fails";
	  }
	| {
			readonly kind: "binding";
			readonly assertion:
				| "connection-uri-parses"
				| "tls-negotiated"
				| "credential-is-reference";
	  }
	| {
			readonly kind: "process";
			readonly tool: string;
			readonly assertion: string;
	  }
	| { readonly kind: "static"; readonly assertion: string };

export type PostgresConformanceCase = {
	/** Stable identifier. Appears verbatim in a conformance report. */
	readonly id: string;
	readonly title: string;
	/** The structured capability key this case proves. */
	readonly capabilityKey: string;
	readonly appliesWhen: PostgresConformancePrecondition;
	readonly check: PostgresConformanceCheck;
	/** Cases that must pass first; a dependency failure short-circuits. */
	readonly dependsOn: readonly string[];
	readonly rationale: string;
};

export type PostgresConformanceSuite = {
	readonly suiteRef: typeof POSTGRES_CONFORMANCE_SUITE_REF;
	readonly profileId: "data.postgres/v1";
	readonly cases: readonly PostgresConformanceCase[];
};

const sql = (
	statements: readonly string[],
	expect: "all-succeed" | "last-fails" = "all-succeed",
): PostgresConformanceCheck => ({ kind: "sql", statements, expect });

const CASES: readonly PostgresConformanceCase[] = [
	{
		id: "postgres.wire.protocol",
		title: "Speaks the PostgreSQL frontend/backend protocol",
		capabilityKey: "postgresWireProtocol",
		appliesWhen: {
			operator: "equals",
			key: "postgresWireProtocol",
			value: true,
		},
		check: sql(["SELECT version();"]),
		dependsOn: [],
		rationale:
			"Everything else in this suite assumes a libpq-class session. If this fails, the product is relational at best, and D1-shaped products land here.",
	},
	{
		id: "postgres.wire.tls",
		title: "Requires TLS on the client connection",
		capabilityKey: "tls",
		appliesWhen: { operator: "equals", key: "tls", value: true },
		check: { kind: "binding", assertion: "tls-negotiated" },
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"A managed Postgres reachable in cleartext is a credential-disclosure bug, not a configuration preference.",
	},
	{
		id: "postgres.wire.server-version",
		title: "Reports the advertised server major version",
		capabilityKey: "serverVersionMajor",
		appliesWhen: { operator: "present", key: "serverVersionMajor" },
		check: sql(["SHOW server_version_num;"]),
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"A version claim is the one fact the server will contradict for free, so it is checked rather than trusted.",
	},
	{
		id: "postgres.binding.connection-uri",
		title: "Issues a parseable postgres:// connection URI",
		capabilityKey: "connectionUriBinding",
		appliesWhen: {
			operator: "equals",
			key: "connectionUriBinding",
			value: true,
		},
		check: { kind: "binding", assertion: "connection-uri-parses" },
		dependsOn: [],
		rationale:
			"HoBo binds workloads through binding.postgresql/v1. A product that only hands out a proprietary client handle cannot produce that binding.",
	},
	{
		id: "postgres.binding.credential-is-reference",
		title: "The emitted binding carries a secret reference, never material",
		capabilityKey: "connectionUriBinding",
		appliesWhen: {
			operator: "equals",
			key: "connectionUriBinding",
			value: true,
		},
		check: { kind: "binding", assertion: "credential-is-reference" },
		dependsOn: ["postgres.binding.connection-uri"],
		rationale:
			"The binding is what reaches plans, receipts, and logs. This case is the one that keeps a connection string out of an append-only event store.",
	},
	{
		id: "postgres.schema.ddl",
		title: "The application role can create, alter, and drop objects",
		capabilityKey: "ddl",
		appliesWhen: { operator: "equals", key: "ddl", value: true },
		check: sql([
			"CREATE TABLE hobo_conformance_ddl (id integer PRIMARY KEY);",
			"ALTER TABLE hobo_conformance_ddl ADD COLUMN label text;",
			"DROP TABLE hobo_conformance_ddl;",
		]),
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"Migration tools own the schema. A read-mostly role that silently lacks DDL turns every deploy into a runtime failure.",
	},
	{
		id: "postgres.schema.constraints",
		title: "Declared constraints and indexes are enforced",
		capabilityKey: "constraints",
		appliesWhen: { operator: "equals", key: "constraints", value: true },
		check: sql(
			[
				"CREATE TABLE hobo_conformance_constraint (id integer PRIMARY KEY, email text UNIQUE NOT NULL);",
				"INSERT INTO hobo_conformance_constraint VALUES (1, 'a@example.test');",
				"INSERT INTO hobo_conformance_constraint VALUES (2, 'a@example.test');",
			],
			"last-fails",
		),
		dependsOn: ["postgres.schema.ddl"],
		rationale:
			"Accepting a UNIQUE declaration and not enforcing it is a documented behaviour of some SQL-compatible engines, and it corrupts data silently.",
	},
	{
		id: "postgres.transactions.commit",
		title: "Multi-statement transactions commit atomically",
		capabilityKey: "transactions",
		appliesWhen: { operator: "equals", key: "transactions", value: true },
		check: sql([
			"BEGIN;",
			"CREATE TABLE hobo_conformance_tx (id integer PRIMARY KEY);",
			"INSERT INTO hobo_conformance_tx VALUES (1);",
			"COMMIT;",
			"DROP TABLE hobo_conformance_tx;",
		]),
		dependsOn: ["postgres.schema.ddl"],
		rationale: "The baseline relational guarantee.",
	},
	{
		id: "postgres.transactions.rollback",
		title: "ROLLBACK discards work, including DDL",
		capabilityKey: "transactionRollback",
		appliesWhen: {
			operator: "equals",
			key: "transactionRollback",
			value: true,
		},
		check: sql(
			[
				"BEGIN;",
				"CREATE TABLE hobo_conformance_rollback (id integer PRIMARY KEY);",
				"ROLLBACK;",
				"SELECT * FROM hobo_conformance_rollback;",
			],
			"last-fails",
		),
		dependsOn: ["postgres.transactions.commit"],
		rationale:
			"Transactional DDL is what makes a failed migration recoverable. Engines that auto-commit DDL leave a half-migrated schema behind.",
	},
	{
		id: "postgres.transactions.isolation",
		title: "Requested isolation levels are honoured, not silently upgraded",
		capabilityKey: "isolationLevels",
		appliesWhen: { operator: "present", key: "isolationLevels" },
		check: sql([
			"BEGIN ISOLATION LEVEL SERIALIZABLE;",
			"SHOW transaction_isolation;",
			"COMMIT;",
		]),
		dependsOn: ["postgres.transactions.commit"],
		rationale:
			"A pooled or proxied endpoint can quietly serve a different isolation level than the one requested.",
	},
	{
		id: "postgres.statements.prepared",
		title:
			"Server-side prepared statements work over the extended query protocol",
		capabilityKey: "preparedStatements",
		appliesWhen: { operator: "equals", key: "preparedStatements", value: true },
		check: sql([
			"PREPARE hobo_conformance_stmt (integer) AS SELECT $1;",
			"EXECUTE hobo_conformance_stmt(1);",
			"DEALLOCATE hobo_conformance_stmt;",
		]),
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"Transaction-mode poolers commonly break prepared statements. Clients that default to them then fail intermittently under load.",
	},
	{
		id: "postgres.types.json",
		title: "JSON document columns store and query",
		capabilityKey: "jsonDocuments",
		appliesWhen: { operator: "equals", key: "jsonDocuments", value: true },
		check: sql(["SELECT ('{\"a\":1}'::json) ->> 'a';"]),
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"Declared by data.relational/v1 and relied on by most application schemas.",
	},
	{
		id: "postgres.types.jsonb",
		title: "The binary jsonb type and its operators are available",
		capabilityKey: "jsonb",
		appliesWhen: { operator: "equals", key: "jsonb", value: true },
		check: sql(["SELECT ('{\"a\":1}'::jsonb) @> '{\"a\":1}'::jsonb;"]),
		dependsOn: ["postgres.types.json"],
		rationale:
			"`jsonb` containment and GIN indexing are what make JSON columns queryable at size; `json` alone is text with a parser.",
	},
	{
		id: "postgres.extensions.installable",
		title: "Advertised extensions are actually installable",
		capabilityKey: "extensions",
		appliesWhen: { operator: "present", key: "extensions" },
		check: sql(["SELECT name FROM pg_available_extensions;"]),
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"An extension list is the claim most often copied from a marketing page. `pg_available_extensions` is the one that decides.",
	},
	{
		id: "postgres.connectivity.limits",
		title: "The advertised connection ceiling is the real one",
		capabilityKey: "maxConnections",
		appliesWhen: { operator: "present", key: "maxConnections" },
		check: sql(["SHOW max_connections;"]),
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"A serverless caller without a pooler exhausts a small ceiling immediately, and the failure looks like an application bug.",
	},
	{
		id: "postgres.connectivity.pooled-endpoint",
		title: "A pooled endpoint accepts sessions",
		capabilityKey: "pooling",
		appliesWhen: { operator: "equals", key: "pooling", value: true },
		check: { kind: "binding", assertion: "connection-uri-parses" },
		dependsOn: ["postgres.binding.connection-uri"],
		rationale:
			"A pooled host that does not resolve is a common copy-paste error in a provider adapter.",
	},
	{
		id: "postgres.connectivity.edge-transport",
		title: "An edge or WASM caller can reach the server",
		capabilityKey: "connectivityTransports",
		appliesWhen: { operator: "present", key: "connectivityTransports" },
		check: {
			kind: "static",
			assertion: "advertised-transports-have-a-connectivity-implementation",
		},
		dependsOn: [],
		rationale:
			"Speaking the Postgres protocol says nothing about reachability from a runtime with no raw TCP. That is a separate, checkable fact.",
	},
	{
		id: "postgres.migration.pg-dump",
		title: "pg_dump produces a restorable archive",
		capabilityKey: "migrationToolCompatibility",
		appliesWhen: {
			operator: "includes",
			key: "migrationToolCompatibility",
			value: "pg-dump",
		},
		check: {
			kind: "process",
			tool: "pg-dump",
			assertion: "archive-round-trips-through-pg-restore",
		},
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"The export path is the exit door. It is proven by round-tripping, not by the presence of a binary on PATH.",
	},
	{
		id: "postgres.migration.tooling",
		title: "Advertised migration tools run against this product",
		capabilityKey: "migrationToolCompatibility",
		appliesWhen: { operator: "present", key: "migrationToolCompatibility" },
		check: {
			kind: "process",
			tool: "advertised",
			assertion: "each-advertised-tool-applies-a-migration",
		},
		dependsOn: ["postgres.schema.ddl"],
		rationale:
			"Tool compatibility is a product claim. Shadow-database requirements and advisory-lock behaviour break tools on otherwise conformant servers.",
	},
	{
		id: "postgres.migration.logical-replication",
		title: "Publications and subscriptions are available",
		capabilityKey: "logicalReplication",
		appliesWhen: { operator: "equals", key: "logicalReplication", value: true },
		check: sql(["SELECT * FROM pg_publication;"]),
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"A zero-downtime copy needs this, and most claimable products decide it at creation time and cannot enable it later.",
	},
	{
		id: "postgres.credentials.rotation",
		title: "The owner can replace a live credential the advertised way",
		capabilityKey: "credentialRotation",
		appliesWhen: { operator: "present", key: "credentialRotation" },
		check: {
			kind: "static",
			assertion: "rotation-mode-has-a-documented-owner-procedure",
		},
		dependsOn: [],
		rationale:
			"After a claim, rotation is what actually removes the creating party's authority. `none` is a legitimate answer and it changes the trust ranking.",
	},
	{
		id: "postgres.portability.export",
		title: "A full logical export can be taken",
		capabilityKey: "exportSupported",
		appliesWhen: { operator: "equals", key: "exportSupported", value: true },
		check: {
			kind: "process",
			tool: "pg-dump",
			assertion: "full-schema-and-data-export-completes",
		},
		dependsOn: ["postgres.migration.pg-dump"],
		rationale:
			"Portability is a gate in trust policy, so it needs evidence rather than an assertion.",
	},
	{
		id: "postgres.portability.import",
		title: "A logical export can be restored into this product",
		capabilityKey: "importSupported",
		appliesWhen: { operator: "equals", key: "importSupported", value: true },
		check: {
			kind: "process",
			tool: "pg-restore",
			assertion: "restore-of-a-foreign-archive-completes",
		},
		dependsOn: ["postgres.wire.protocol"],
		rationale:
			"The entry door. Without it a product can receive traffic but never receive data.",
	},
];

export const postgresConformanceSuite: PostgresConformanceSuite = Object.freeze(
	{
		suiteRef: POSTGRES_CONFORMANCE_SUITE_REF,
		profileId: "data.postgres/v1",
		cases: Object.freeze(CASES),
	},
);

const PRODUCT_ID = /^[a-z0-9][a-z0-9.-]{0,62}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * The conformance reference a product records on its profile implementation.
 *
 * It pins three things a reviewer needs: which suite ran, which product it ran
 * against, and when. A product that changes any of them gets a different
 * reference, which changes the catalog digest and therefore the signed
 * resolution receipt.
 */
export function postgresConformanceRef(
	productId: string,
	checkedAt: string,
	suite: PostgresConformanceSuite = postgresConformanceSuite,
): string {
	if (!PRODUCT_ID.test(productId)) {
		throw new PostgresDataError(
			"CONFORMANCE_SUITE_INVALID",
			`conformance product id ${JSON.stringify(productId)} must be a lowercase dotted identifier`,
		);
	}
	if (!ISO_DATE.test(checkedAt)) {
		throw new PostgresDataError(
			"CONFORMANCE_SUITE_INVALID",
			"conformance reference needs an ISO date a human actually checked",
		);
	}
	return `hobo.conformance/${suite.profileId}#${productId}@${checkedAt}`;
}

/**
 * Structural checks on a suite: unique ids, capability keys that exist, and a
 * dependency graph that terminates. Run on the standard suite by its own test,
 * and available to anyone assembling a product-specific extension of it.
 */
export function assertConformanceSuiteWellFormed(
	suite: PostgresConformanceSuite,
): PostgresConformanceSuite {
	const byId = new Map<string, PostgresConformanceCase>();
	for (const testCase of suite.cases) {
		if (byId.has(testCase.id)) {
			throw new PostgresDataError(
				"CONFORMANCE_SUITE_INVALID",
				`duplicate conformance case id ${testCase.id}`,
			);
		}
		if (postgresCapability(testCase.capabilityKey) === undefined) {
			throw new PostgresDataError(
				"CONFORMANCE_SUITE_INVALID",
				`case ${testCase.id} proves unknown capability key ${testCase.capabilityKey}`,
			);
		}
		if (postgresCapability(testCase.appliesWhen.key) === undefined) {
			throw new PostgresDataError(
				"CONFORMANCE_SUITE_INVALID",
				`case ${testCase.id} is gated on unknown capability key ${testCase.appliesWhen.key}`,
			);
		}
		byId.set(testCase.id, testCase);
	}

	const state = new Map<string, "visiting" | "done">();
	const visit = (id: string, from: string): void => {
		const node = byId.get(id);
		if (node === undefined) {
			throw new PostgresDataError(
				"CONFORMANCE_SUITE_INVALID",
				`case ${from} depends on unknown case ${id}`,
			);
		}
		const seen = state.get(id);
		if (seen === "done") return;
		if (seen === "visiting") {
			throw new PostgresDataError(
				"CONFORMANCE_SUITE_INVALID",
				`conformance dependency cycle through ${id}`,
			);
		}
		state.set(id, "visiting");
		for (const dependency of node.dependsOn) visit(dependency, id);
		state.set(id, "done");
	};
	for (const testCase of suite.cases) visit(testCase.id, testCase.id);
	return suite;
}

function advertises(
	advertised: PostgresStructuredCapabilities,
	precondition: PostgresConformancePrecondition,
): boolean {
	const value = advertised[precondition.key];
	if (value === undefined) return false;
	switch (precondition.operator) {
		case "present":
			return Array.isArray(value) ? value.length > 0 : true;
		case "equals":
			return value === precondition.value;
		case "includes":
			return (
				Array.isArray(value) &&
				// SAFETY: the array branch establishes the advertised string-set representation.
				(value as readonly string[]).includes(precondition.value)
			);
		default:
			return false;
	}
}

export type PostgresConformanceSkip = {
	readonly caseId: string;
	readonly reason: "not-advertised" | "dependency-not-applicable";
};

export type PostgresConformancePlan = {
	readonly suiteRef: string;
	/** In dependency order, so a runner can short-circuit on first failure. */
	readonly applicable: readonly PostgresConformanceCase[];
	readonly skipped: readonly PostgresConformanceSkip[];
	/** Executor kinds the applicable cases need. */
	readonly requiredExecutors: readonly PostgresConformanceExecutorKind[];
};

/**
 * Decide which cases a product owes, given what it advertises.
 *
 * A case whose dependency is not applicable is skipped rather than failed: if a
 * product does not claim DDL, its constraint enforcement is untestable, not
 * broken. The `constraints` guarantee then fails at the selection gate on
 * absence, which is the correct place for it.
 */
export function planPostgresConformance(
	advertised: PostgresStructuredCapabilities,
	suite: PostgresConformanceSuite = postgresConformanceSuite,
): PostgresConformancePlan {
	const applicableIds = new Set<string>();
	const applicable: PostgresConformanceCase[] = [];
	const skipped: PostgresConformanceSkip[] = [];

	// `suite.cases` is authored in dependency order; walking it once therefore
	// resolves every dependency before its dependents.
	for (const testCase of suite.cases) {
		if (!advertises(advertised, testCase.appliesWhen)) {
			skipped.push({ caseId: testCase.id, reason: "not-advertised" });
			continue;
		}
		const missingDependency = testCase.dependsOn.some(
			(id) => !applicableIds.has(id),
		);
		if (missingDependency) {
			skipped.push({
				caseId: testCase.id,
				reason: "dependency-not-applicable",
			});
			continue;
		}
		applicableIds.add(testCase.id);
		applicable.push(testCase);
	}

	const requiredExecutors = [
		...new Set(applicable.map((testCase) => testCase.check.kind)),
	].sort((a, b) => a.localeCompare(b));

	return {
		suiteRef: suite.suiteRef,
		applicable,
		skipped,
		requiredExecutors,
	};
}

export type PostgresConformanceObservation = {
	readonly passed: boolean;
	/** Operator-facing detail. Must never contain credential material. */
	readonly detail: string;
};

export type PostgresConformanceExecutorInput = {
	readonly caseId: string;
	readonly capabilityKey: string;
	readonly check: PostgresConformanceCheck;
	readonly advertised: PostgresStructuredCapabilities;
};

export type PostgresConformanceExecutor = (
	input: PostgresConformanceExecutorInput,
) => Promise<PostgresConformanceObservation>;

/** Injected side of the suite. Absent kinds make their cases `not-run`. */
export type PostgresConformanceExecutors = Partial<
	Record<PostgresConformanceExecutorKind, PostgresConformanceExecutor>
>;

export type PostgresConformanceResultStatus =
	| "pass"
	| "fail"
	| "not-run"
	| "blocked";

// parallel-type-allowed: the in-process result carries the closed status union this module folds over; the proto PostgresConformanceResult is the recorded wire projection of it.
export type PostgresConformanceResult = {
	readonly caseId: string;
	readonly capabilityKey: string;
	readonly status: PostgresConformanceResultStatus;
	readonly detail: string;
};

export type PostgresConformanceOutcome = "pass" | "fail" | "unknown";

// parallel-type-allowed: the run-time report also carries `skipped`, which is planning detail rather than recorded evidence; the proto PostgresConformanceReport is the durable subset.
export type PostgresConformanceReport = {
	readonly suiteRef: string;
	/** Matches `ProfileImplementation.conformance` exactly. */
	readonly outcome: PostgresConformanceOutcome;
	readonly results: readonly PostgresConformanceResult[];
	readonly skipped: readonly PostgresConformanceSkip[];
	readonly ranAtMs: number;
};

export type RunPostgresConformanceInput = {
	readonly advertised: PostgresStructuredCapabilities;
	readonly executors: PostgresConformanceExecutors;
	/** Injected instant. This module never reads a clock. */
	readonly nowMs: number;
	readonly suite?: PostgresConformanceSuite;
};

/**
 * Run the applicable cases and fold them into one outcome.
 *
 * The fold is deliberately pessimistic: any failure is `fail`, and anything
 * unproven is `unknown`. Selection treats both as non-selectable, so the only
 * way to be picked is to have actually run the checks.
 */
export async function runPostgresConformance(
	input: RunPostgresConformanceInput,
): Promise<PostgresConformanceReport> {
	const suite = input.suite ?? postgresConformanceSuite;
	const plan = planPostgresConformance(input.advertised, suite);
	const results: PostgresConformanceResult[] = [];
	// A case blocked by a *failed* dependency is evidence of a defect; a case
	// blocked by an *unrun* one is only evidence that nobody looked. Collapsing
	// the two would let a missing executor masquerade as a product failure.
	const failed = new Set<string>();
	const unproven = new Set<string>();

	for (const testCase of plan.applicable) {
		const failedDependency = testCase.dependsOn.find((id) => failed.has(id));
		if (failedDependency !== undefined) {
			failed.add(testCase.id);
			results.push({
				caseId: testCase.id,
				capabilityKey: testCase.capabilityKey,
				status: "blocked",
				detail: `dependency ${failedDependency} failed`,
			});
			continue;
		}
		const unprovenDependency = testCase.dependsOn.find((id) =>
			unproven.has(id),
		);
		if (unprovenDependency !== undefined) {
			unproven.add(testCase.id);
			results.push({
				caseId: testCase.id,
				capabilityKey: testCase.capabilityKey,
				status: "not-run",
				detail: `dependency ${unprovenDependency} was not run`,
			});
			continue;
		}

		const executor = input.executors[testCase.check.kind];
		if (executor === undefined) {
			unproven.add(testCase.id);
			results.push({
				caseId: testCase.id,
				capabilityKey: testCase.capabilityKey,
				status: "not-run",
				detail: `no ${testCase.check.kind} executor was provided`,
			});
			continue;
		}

		let observation: PostgresConformanceObservation;
		try {
			observation = await executor({
				caseId: testCase.id,
				capabilityKey: testCase.capabilityKey,
				check: testCase.check,
				advertised: input.advertised,
			});
		} catch (cause) {
			failed.add(testCase.id);
			results.push({
				caseId: testCase.id,
				capabilityKey: testCase.capabilityKey,
				status: "fail",
				// The thrown message is not repeated: an executor talking to a
				// real server can easily carry a DSN in its error text.
				detail:
					cause instanceof Error
						? `executor threw ${cause.name}`
						: "executor threw a non-Error value",
			});
			continue;
		}

		if (!observation.passed) failed.add(testCase.id);
		results.push({
			caseId: testCase.id,
			capabilityKey: testCase.capabilityKey,
			status: observation.passed ? "pass" : "fail",
			detail: observation.detail,
		});
	}

	const hasFailure = results.some(
		(result) => result.status === "fail" || result.status === "blocked",
	);
	const hasUnrun = results.some((result) => result.status === "not-run");
	const outcome: PostgresConformanceOutcome = hasFailure
		? "fail"
		: hasUnrun
			? "unknown"
			: "pass";

	return {
		suiteRef: plan.suiteRef,
		outcome,
		results,
		skipped: plan.skipped,
		ranAtMs: input.nowMs,
	};
}

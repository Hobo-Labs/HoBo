import {
	BUDGET_POLICY_SCHEMA,
	evaluateBudgetPolicy,
	parseBudgetPolicy,
} from "@hobo/core";
import {
	type BillingPeriod,
	DEFAULT_FLEET_POLICY,
	type FleetBudgetCheck,
	type FleetPolicy,
	type PostgresFleetFinancialModel,
	parseFleetBackendId,
	parseFleetFinancialModel,
	parseFleetLayout,
	parseFleetPolicy,
} from "@hobo/data-postgres";
import {
	KNOWN_TRANSACTION_POOLERS,
	PGBOUNCER_PORT_POOLER,
	type RelayDatabase,
	relayDatabase,
	type TransactionPoolerRule,
} from "./database-connections.js";

/** The relay's tables. Everything under `hobo_ci_` is copied to standbys,
 * except the fleet's own control tables and the schema migration ledger
 * (`hobo_ci_schema_migrations`, written by the migration runner): what has
 * been applied to one database says nothing about another. */
export const RELAY_FLEET_LAYOUT = parseFleetLayout({
	dataPrefix: "hobo_ci_",
	controlPrefix: "hobo_ci_fleet_",
	excludedTables: ["hobo_ci_schema_migrations"],
});

/** Find one backend's connections in the environment, under its prefix. The
 * certificate authority is per backend (`<PREFIX>HOBO_CI_DATABASE_CA_CERT`):
 * one provider's private root must not be imposed on another. */
export function environmentConnection(
	env: NodeJS.ProcessEnv,
	prefix: string,
	transactionPoolers: readonly TransactionPoolerRule[] = [],
): RelayDatabase {
	return relayDatabase(
		{
			...env,
			HOBO_CI_DATABASE_ENV_PREFIX: prefix,
			HOBO_CI_DATABASE_CA_CERT: env[`${prefix}HOBO_CI_DATABASE_CA_CERT`],
		},
		transactionPoolers,
	);
}

/** Everything the relay knows about one kind of PostgreSQL backend, as data.
 * Adding a provider is adding a record; no code branches on a provider. */
export type DatabaseBackendProfile = {
	hosting: "managed" | "self-hosted";
	/** How its connections are found. A provider whose credential is a
	 * short-lived token minted per connection supplies a function that returns
	 * pool settings with an async `password`; none does today. */
	connection: (
		env: NodeJS.ProcessEnv,
		prefix: string,
		transactionPoolers: readonly TransactionPoolerRule[],
	) => RelayDatabase;
	/** Addresses of its transaction-mode poolers, refused for this backend's
	 * session connection. */
	transactionPoolers: readonly TransactionPoolerRule[];
	/** Whether its server certificate chains to the provider's own root. */
	privateCertificateAuthority: "yes" | "no" | "depends";
	financial: Omit<PostgresFleetFinancialModel, "backend">;
};

const UNVERIFIED = {
	source:
		"not verified: no plan number has been read from the provider and recorded here",
	observedAt: "2026-11-10",
};

/** A plan with nothing recorded: the policy neither moves away from such a
 * backend on budget grounds nor moves to it. */
const UNVERIFIED_PLAN = {
	plan: "unverified",
	fixedMonthlyFeeMicros: undefined,
	allowances: [],
	evidence: UNVERIFIED,
} satisfies Omit<PostgresFleetFinancialModel, "backend">;

/** The provider profiles. Financial numbers are recorded only where a source
 * states them; everything else is `undefined` (unknown), which the policy
 * neither moves away from nor moves to. */
export const DATABASE_BACKEND_PROFILES = {
	neon: {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: KNOWN_TRANSACTION_POOLERS.neon,
		privateCertificateAuthority: "no",
		financial: {
			plan: "unverified",
			fixedMonthlyFeeMicros: undefined,
			allowances: [
				{
					unit: "compute-hours",
					included: undefined,
					beyond: "unknown",
					meteredMicrosPerUnit: undefined,
				},
				{
					unit: "storage-bytes",
					included: undefined,
					beyond: "unknown",
					meteredMicrosPerUnit: undefined,
				},
			],
			evidence: UNVERIFIED,
		},
	},
	supabase: {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: KNOWN_TRANSACTION_POOLERS.supabase,
		privateCertificateAuthority: "yes",
		financial: {
			plan: "unverified",
			fixedMonthlyFeeMicros: undefined,
			allowances: [
				{
					unit: "storage-bytes",
					included: undefined,
					beyond: "unknown",
					meteredMicrosPerUnit: undefined,
				},
			],
			evidence: UNVERIFIED,
		},
	},
	"prisma-postgres": {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: KNOWN_TRANSACTION_POOLERS["prisma-postgres"],
		privateCertificateAuthority: "no",
		financial: {
			plan: "free",
			fixedMonthlyFeeMicros: 0,
			allowances: [
				{
					unit: "operations",
					included: 200_000,
					// The page states the allowance, not what follows it.
					beyond: "unknown",
					meteredMicrosPerUnit: undefined,
				},
				{
					unit: "storage-bytes",
					included: 2_000_000_000,
					beyond: "unknown",
					meteredMicrosPerUnit: undefined,
				},
			],
			evidence: {
				source:
					"Vercel Marketplace page for Prisma Postgres, free plan: 200,000 operations a month and 2 GB, as recorded by the project owner",
				observedAt: "2026-11-10",
			},
		},
	},
	// The four below share one fact from the PostgreSQL backend catalog: the
	// managed pooler is PgBouncer on port 6432 of the same host as the direct
	// endpoint on 5432. No plan number is recorded for any of them.
	"planetscale-postgres": {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: PGBOUNCER_PORT_POOLER,
		privateCertificateAuthority: "no",
		financial: UNVERIFIED_PLAN,
	},
	"azure-postgres-flexible": {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: PGBOUNCER_PORT_POOLER,
		privateCertificateAuthority: "no",
		financial: UNVERIFIED_PLAN,
	},
	"gcp-cloudsql-postgres": {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: PGBOUNCER_PORT_POOLER,
		privateCertificateAuthority: "depends",
		financial: UNVERIFIED_PLAN,
	},
	"gcp-alloydb": {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: PGBOUNCER_PORT_POOLER,
		privateCertificateAuthority: "depends",
		financial: UNVERIFIED_PLAN,
	},
	// Amazon RDS and Aurora: the pooler (RDS Proxy) is a separate resource with
	// its own hostname, and no address pattern for it is recorded, so nothing
	// is refused by address. Their certificates chain to Amazon's own root.
	"aws-rds-postgres": {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: [],
		privateCertificateAuthority: "yes",
		financial: UNVERIFIED_PLAN,
	},
	"aws-aurora-postgres": {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: [],
		privateCertificateAuthority: "yes",
		financial: UNVERIFIED_PLAN,
	},
	// Preview. No built-in pooler; its certificate authority is not recorded.
	"azure-horizondb": {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: [],
		privateCertificateAuthority: "depends",
		financial: UNVERIFIED_PLAN,
	},
	// Little about its cloud service is confirmed from a primary source.
	"pgedge-cloud": {
		hosting: "managed",
		connection: environmentConnection,
		transactionPoolers: [],
		privateCertificateAuthority: "depends",
		financial: UNVERIFIED_PLAN,
	},
	/** Any PostgreSQL the operator runs or rents, with no known plan. */
	postgres: {
		hosting: "self-hosted",
		connection: environmentConnection,
		transactionPoolers: [],
		privateCertificateAuthority: "depends",
		financial: {
			plan: "unverified",
			fixedMonthlyFeeMicros: undefined,
			allowances: [],
			evidence: UNVERIFIED,
		},
	},
} satisfies { [profile: string]: DatabaseBackendProfile };

export type DatabaseBackendProfileName = keyof typeof DATABASE_BACKEND_PROFILES;

function profileNamed(name: string): DatabaseBackendProfileName | undefined {
	return Object.keys(DATABASE_BACKEND_PROFILES).find(
		(candidate): candidate is DatabaseBackendProfileName => candidate === name,
	);
}

export type DatabaseFleetBackend = {
	id: string;
	prefix: string;
	profileName: DatabaseBackendProfileName;
	profile: DatabaseBackendProfile;
	database: RelayDatabase;
	model: PostgresFleetFinancialModel;
};

export type DatabaseFleetConfig = {
	/** In configured order. The first is the writer of an empty fleet. */
	backends: DatabaseFleetBackend[];
	policy: FleetPolicy;
	/** How long an instance may trust the assignment it last confirmed. */
	leaseMs: number;
	/** Added to a lease when waiting for writers to stop after sealing. */
	graceMs: number;
	/** The relay database's monthly budget, in millionths of a US dollar. */
	budgetLimitMicros: number;
};

function seconds(
	env: NodeJS.ProcessEnv,
	name: string,
	fallbackMs: number,
	minimum: number,
	maximum: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallbackMs;
	const value = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new Error(`invalid ${name}`);
	return value * 1000;
}

/** Parse `HOBO_CI_DATABASE_BACKENDS`, a comma-separated list of
 * `id=PREFIX` or `id=PREFIX:profile`. Returns nothing when it is unset, which
 * is the single-database relay. Anything malformed throws: a relay that cannot
 * tell which databases it has must not start. */
export function parseDatabaseFleet(
	env: NodeJS.ProcessEnv,
): DatabaseFleetConfig | undefined {
	const raw = env.HOBO_CI_DATABASE_BACKENDS;
	if (raw === undefined || raw === "") return undefined;
	if (env.HOBO_CI_DATABASE_ENV_PREFIX)
		throw new Error(
			"HOBO_CI_DATABASE_BACKENDS and HOBO_CI_DATABASE_ENV_PREFIX are mutually exclusive",
		);
	const backends: DatabaseFleetBackend[] = [];
	for (const entry of raw.split(",")) {
		const match =
			/^([a-z0-9][a-z0-9_-]{0,62})=([A-Za-z][A-Za-z0-9_]*)?(?::([a-z][a-z0-9-]*))?$/.exec(
				entry,
			);
		if (!match?.[1]) throw new Error("invalid HOBO_CI_DATABASE_BACKENDS");
		const id = parseFleetBackendId(match[1]);
		const prefix = match[2] ?? "";
		const profileName = profileNamed(match[3] ?? id) ?? "postgres";
		if (match[3] !== undefined && profileNamed(match[3]) === undefined)
			throw new Error("unknown backend profile in HOBO_CI_DATABASE_BACKENDS");
		if (backends.some((other) => other.id === id || other.prefix === prefix))
			throw new Error("repeated backend in HOBO_CI_DATABASE_BACKENDS");
		const profile: DatabaseBackendProfile =
			DATABASE_BACKEND_PROFILES[profileName];
		backends.push({
			id,
			prefix,
			profileName,
			profile,
			database: profile.connection(env, prefix, profile.transactionPoolers),
			model: parseFleetFinancialModel({ ...profile.financial, backend: id }),
		});
	}
	const budget = env.HOBO_CI_DATABASE_MONTHLY_BUDGET_MICROS ?? "0";
	if (!/^\d{1,15}$/.test(budget))
		throw new Error("invalid HOBO_CI_DATABASE_MONTHLY_BUDGET_MICROS");
	const leaseMs = seconds(
		env,
		"HOBO_CI_DATABASE_LEASE_SECONDS",
		30_000,
		2,
		600,
	);
	return {
		backends,
		policy: parseFleetPolicy({
			...DEFAULT_FLEET_POLICY,
			rpoMs: seconds(
				env,
				"HOBO_CI_DATABASE_RPO_SECONDS",
				DEFAULT_FLEET_POLICY.rpoMs,
				0,
				7 * 86_400,
			),
			failoverAfterMs: seconds(
				env,
				"HOBO_CI_DATABASE_FAILOVER_AFTER_SECONDS",
				DEFAULT_FLEET_POLICY.failoverAfterMs,
				0,
				3600,
			),
		}),
		leaseMs,
		graceMs: Math.max(1000, Math.ceil(leaseMs / 6)),
		budgetLimitMicros: Number(budget),
	};
}

const WORKLOAD = "relay-database";

/** The fleet's budget check, answered by HoBo's budget policy evaluator.
 *
 * The budget is one monthly amount for the relay database. Each allowance a
 * backend's plan states becomes a constraint for that backend, so "the next
 * period fits this plan and this budget" is one evaluation, and a metric the
 * evaluator needs but was not given fails closed. */
export function createFleetBudgetCheck(options: {
	limitMicros: number;
	models: readonly PostgresFleetFinancialModel[];
	period: BillingPeriod;
}): FleetBudgetCheck {
	return (request) => {
		const model = options.models.find(
			(candidate) => candidate.backend === request.backend,
		);
		const policy = parseBudgetPolicy({
			schemaVersion: BUDGET_POLICY_SCHEMA,
			tenantId: "hobo-ci",
			budgetId: WORKLOAD,
			periodId: options.period.id,
			revision: "1",
			workloads: [WORKLOAD],
			currency: "USD",
			limitMicros: options.limitMicros,
			objective: "min-cost",
			enforcement: "conservative",
			periodKind: "manual",
			constraints: (model?.allowances ?? [])
				.filter((allowance) => allowance.beyond !== "metered")
				.flatMap((allowance) =>
					allowance.included === undefined
						? []
						: [
								{
									key: `database.${allowance.unit}`,
									workload: WORKLOAD,
									unit: allowance.unit,
									maximum: allowance.included,
									target: request.backend,
								},
							],
				),
		});
		const evaluation = evaluateBudgetPolicy(policy, {
			workload: WORKLOAD,
			tenantId: "hobo-ci",
			budgetId: WORKLOAD,
			periodId: options.period.id,
			policyRevision: "1",
			nowMs: request.nowMs,
			costBoundMicros: request.costBoundMicros,
			exposureMicros: 0,
			boundKind: "conservative",
			phase: "plan",
			measurements: request.measurements.map((measurement) => ({
				key: `database.${measurement.unit}`,
				unit: measurement.unit,
				value: measurement.used,
				target: request.backend,
			})),
		});
		return {
			ok: evaluation.ok,
			code: evaluation.code,
			reason: evaluation.reason,
		};
	};
}

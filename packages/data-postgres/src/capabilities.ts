/**
 * The structured vocabulary a PostgreSQL product advertises.
 *
 * Two rules make this useful rather than decorative:
 *
 * 1. Every key here is a *key* in `SelectionCandidate.structuredCapabilities`,
 *    matched by operator, never by prose. `"supports transactions"` in a README
 *    is not a capability; `transactionRollback: true` with a passing conformance
 *    case is.
 * 2. An unset key fails a `required` feature gate. Absent beats optimistic —
 *    a product that has not proven `extensions` should lose a requirement that
 *    asks for `vector`, not win it by silence.
 *
 * The `data.postgres/v1` and `data.relational/v1` descriptors in
 * `@hobo/capability-profiles` already name a core subset (`serverVersion`,
 * `extensions`, `maxConnections`, `pooling`, `postgresWireProtocol`, `tls`,
 * `jsonDocuments`, `preparedStatements`, `maxStorageBytes`, `transactions`,
 * `constraints`). Those keys are re-declared here verbatim so this package can
 * be the single authoring vocabulary, and the profile-alignment test asserts
 * they have not drifted apart.
 */

export type PostgresCapabilityValueKind =
	| "boolean"
	| "integer"
	| "semver-range"
	| "string-set"
	| "enum";

export type PostgresCapabilityDescriptor = {
	readonly key: string;
	readonly description: string;
	readonly valueKind: PostgresCapabilityValueKind;
	/** Which axis of the profile this key belongs to. */
	readonly axis: PostgresCapabilityAxis;
	/** Closed value domain for `enum` and `string-set` keys. */
	readonly domain?: readonly string[];
	/** True when `data.postgres/v1` or its parent already declares this key. */
	readonly declaredByProfile: boolean;
};
type MutablePostgresCapabilityDescriptor = {
	-readonly [Key in keyof PostgresCapabilityDescriptor]: PostgresCapabilityDescriptor[Key];
};

export const POSTGRES_CAPABILITY_AXES = [
	"wire-protocol",
	"binding",
	"schema",
	"transactions",
	"statements",
	"types",
	"migration",
	"connectivity",
	"extensions",
	"credentials",
	"portability",
] as const;

export type PostgresCapabilityAxis = (typeof POSTGRES_CAPABILITY_AXES)[number];

/** Isolation levels a product may advertise, in PostgreSQL's own naming. */
export const POSTGRES_ISOLATION_LEVELS = [
	"read-uncommitted",
	"read-committed",
	"repeatable-read",
	"serializable",
] as const;

export type PostgresIsolationLevel = (typeof POSTGRES_ISOLATION_LEVELS)[number];

/** Transports a client can reach the server over. */
export const POSTGRES_CONNECTIVITY_TRANSPORTS = [
	"tcp",
	"tls-tcp",
	"http",
	"websocket",
] as const;

export type PostgresConnectivityTransport =
	(typeof POSTGRES_CONNECTIVITY_TRANSPORTS)[number];

/**
 * Migration tools whose compatibility is a *product* claim, not an inference.
 * Speaking the wire protocol does not imply a tool works: a serverless HTTP-only
 * endpoint speaks Postgres and still cannot run `pg_dump`.
 */
export const POSTGRES_MIGRATION_TOOLS = [
	"pg-dump",
	"pg-restore",
	"psql",
	"prisma-migrate",
	"drizzle-kit",
	"knex",
	"flyway",
	"liquibase",
	"atlas",
	"sqlalchemy-alembic",
] as const;

export type PostgresMigrationTool = (typeof POSTGRES_MIGRATION_TOOLS)[number];

/** How the owner can replace a live credential. `none` is a real answer. */
export const POSTGRES_CREDENTIAL_ROTATION_MODES = [
	"self-service-sql",
	"provider-console",
	"provider-api",
	"none",
] as const;

export type PostgresCredentialRotationMode =
	(typeof POSTGRES_CREDENTIAL_ROTATION_MODES)[number];

const descriptor = (
	key: string,
	axis: PostgresCapabilityAxis,
	valueKind: PostgresCapabilityValueKind,
	description: string,
	options: {
		readonly domain?: readonly string[];
		readonly declaredByProfile?: boolean;
	} = {},
): PostgresCapabilityDescriptor => {
	const result: MutablePostgresCapabilityDescriptor = {
		key,
		axis,
		valueKind,
		description,
		declaredByProfile: options.declaredByProfile ?? false,
	};
	if (options.domain !== undefined) result.domain = options.domain;
	return result;
};

/**
 * Guarantees: monotonic, boolean, and load-bearing. A product that cannot
 * assert one of these is not a PostgreSQL product for HoBo's purposes.
 */
export const POSTGRES_GUARANTEES: readonly PostgresCapabilityDescriptor[] = [
	descriptor(
		"postgresWireProtocol",
		"wire-protocol",
		"boolean",
		"Speaks the PostgreSQL frontend/backend protocol, so any libpq-class client connects unmodified.",
		{ declaredByProfile: true },
	),
	descriptor(
		"tls",
		"wire-protocol",
		"boolean",
		"Requires TLS on the client connection.",
		{
			declaredByProfile: true,
		},
	),
	descriptor(
		"transactions",
		"transactions",
		"boolean",
		"Multi-statement transactions with rollback.",
		{ declaredByProfile: true },
	),
	descriptor(
		"constraints",
		"schema",
		"boolean",
		"Enforces declared constraints and indexes rather than accepting and ignoring them.",
		{ declaredByProfile: true },
	),
	descriptor(
		"connectionUriBinding",
		"binding",
		"boolean",
		"Issues a `postgres(ql)://` connection URI that HoBo can deposit into secret custody and publish as binding.postgresql/v1.",
	),
	descriptor(
		"ddl",
		"schema",
		"boolean",
		"Accepts CREATE/ALTER/DROP from the ordinary application role, so a migration tool can own the schema.",
	),
	descriptor(
		"transactionRollback",
		"transactions",
		"boolean",
		"ROLLBACK actually discards the work of an open transaction, including DDL.",
	),
];

/** Features: ranked, gated, and frequently unset. */
export const POSTGRES_FEATURES: readonly PostgresCapabilityDescriptor[] = [
	descriptor(
		"serverVersion",
		"wire-protocol",
		"semver-range",
		"PostgreSQL server major version.",
		{
			declaredByProfile: true,
		},
	),
	descriptor(
		"serverVersionMajor",
		"wire-protocol",
		"integer",
		"PostgreSQL server major version as an integer. The profile's `serverVersion` range is a human/ranking fact; matching compares numbers, so a product advertises both and a version requirement gates on this one.",
	),
	descriptor(
		"isolationLevels",
		"transactions",
		"string-set",
		"Transaction isolation levels the server honours as requested rather than silently upgrading or ignoring.",
		{ domain: POSTGRES_ISOLATION_LEVELS },
	),
	descriptor(
		"preparedStatements",
		"statements",
		"boolean",
		"Supports server-side prepared statements (extended query protocol).",
		{ declaredByProfile: true },
	),
	descriptor(
		"jsonDocuments",
		"types",
		"boolean",
		"Stores and queries JSON document columns.",
		{ declaredByProfile: true },
	),
	descriptor(
		"jsonb",
		"types",
		"boolean",
		"Supports the binary `jsonb` type and its operators/indexes.",
	),
	descriptor(
		"migrationToolCompatibility",
		"migration",
		"string-set",
		"Migration and schema tools proven to work against this product. Never inferred from the wire protocol.",
		{ domain: POSTGRES_MIGRATION_TOOLS },
	),
	descriptor(
		"maxConnections",
		"connectivity",
		"integer",
		"Maximum concurrent client connections.",
		{
			declaredByProfile: true,
		},
	),
	descriptor(
		"pooling",
		"connectivity",
		"boolean",
		"Provider offers a pooled connection endpoint.",
		{
			declaredByProfile: true,
		},
	),
	descriptor(
		"connectivityTransports",
		"connectivity",
		"string-set",
		"Transports the server is reachable over. An edge or WASM caller needs `http` or `websocket`; raw TCP is not available there.",
		{ domain: POSTGRES_CONNECTIVITY_TRANSPORTS },
	),
	descriptor(
		"extensions",
		"extensions",
		"string-set",
		"Installable PostgreSQL extensions, e.g. `vector`, `postgis`, `pg_trgm`.",
		{ declaredByProfile: true },
	),
	descriptor(
		"credentialRotation",
		"credentials",
		"enum",
		"How the owner replaces a live credential once they control the resource.",
		{ domain: POSTGRES_CREDENTIAL_ROTATION_MODES },
	),
	descriptor(
		"logicalReplication",
		"migration",
		"boolean",
		"Publications and subscriptions are available, which is what a zero-downtime logical copy needs.",
	),
	descriptor(
		"exportSupported",
		"portability",
		"boolean",
		"A full logical export of schema and data can be taken by the owner.",
	),
	descriptor(
		"importSupported",
		"portability",
		"boolean",
		"A logical export can be restored into this product.",
	),
	descriptor(
		"maxStorageBytes",
		"portability",
		"integer",
		"Maximum stored bytes.",
		{
			declaredByProfile: true,
		},
	),
];

export const POSTGRES_CAPABILITIES: readonly PostgresCapabilityDescriptor[] = [
	...POSTGRES_GUARANTEES,
	...POSTGRES_FEATURES,
];

const BY_KEY = new Map<string, PostgresCapabilityDescriptor>(
	POSTGRES_CAPABILITIES.map((entry) => [entry.key, entry]),
);

export function postgresCapability(
	key: string,
): PostgresCapabilityDescriptor | undefined {
	return BY_KEY.get(key);
}

/** Keys of every capability this package knows how to reason about. */
export const POSTGRES_CAPABILITY_KEYS: readonly string[] =
	POSTGRES_CAPABILITIES.map((entry) => entry.key);

/**
 * The value shape a product records for each key. Deliberately not a partial
 * record of unions: a product declares only what it has proven, and everything
 * else stays absent.
 */
export type PostgresStructuredCapabilities = Readonly<
	Record<string, boolean | number | string | readonly string[]>
>;

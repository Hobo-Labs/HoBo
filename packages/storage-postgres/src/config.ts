import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
	type PostgresStoreConfigRecord,
	PostgresStoreConfigRecordSchema,
} from "./_generated/storage_postgres_pb.js";
import { StoragePostgresError } from "./errors.js";
import { parseSchemaName, type SchemaName } from "./identifiers.js";

/**
 * Defaults. The first three mirror `CD_DEFAULTS` in `@hobo/cd`
 * (`postgresMinMajorVersion`, `postgresStatementTimeoutMs`,
 * `postgresPoolSize`); the lease TTL mirrors `CD_DEFAULTS.leaseTtlMs`.
 * This package does not import `@hobo/cd` (storage sits below delivery),
 * so the parity is held by a test instead.
 */
export const POSTGRES_STORE_DEFAULTS = Object.freeze({
	minServerMajorVersion: 16,
	statementTimeoutMs: 5_000,
	poolSize: 10,
	connectionTimeoutMs: 5_000,
	leaseTtlMs: 30_000,
	schema: "hobo_eventstore",
	partitionId: "default",
	applicationName: "hobo-storage-postgres",
});

/** Parsed, range-checked store configuration. */
export type PostgresStoreConfig = Readonly<{
	/** Empty when the caller injects its own pool. */
	connectionString: string;
	schema: SchemaName;
	partitionId: string;
	poolSize: number;
	statementTimeoutMs: number;
	connectionTimeoutMs: number;
	minServerMajorVersion: number;
	leaseTtlMs: number;
	applicationName: string;
}> & { readonly __brand: "storage-postgres.PostgresStoreConfig" };

/** JSON form accepted by `parsePostgresStoreConfig` (proto3 JSON, camelCase or snake_case). */
export type PostgresStoreConfigInput = Readonly<{
	connectionString?: string;
	schema?: string;
	partitionId?: string;
	poolSize?: number;
	statementTimeoutMs?: number;
	connectionTimeoutMs?: number;
	minServerMajorVersion?: number;
	leaseTtlMs?: number;
	applicationName?: string;
}>;

function within(
	value: number,
	fallback: number,
	min: number,
	max: number,
	path: string,
): number {
	const chosen = value === 0 ? fallback : value;
	if (!Number.isSafeInteger(chosen) || chosen < min || chosen > max) {
		throw new StoragePostgresError(
			"invalid-config",
			`${path} must be an integer within ${min}..${max}; received ${chosen}`,
		);
	}
	return chosen;
}

const APPLICATION_NAME = /^[A-Za-z0-9._:-]{1,63}$/u;

function refine(record: PostgresStoreConfigRecord): PostgresStoreConfig {
	const defaults = POSTGRES_STORE_DEFAULTS;
	const schema = parseSchemaName(
		record.schema === "" ? defaults.schema : record.schema,
	);
	const partitionId =
		record.partitionId === "" ? defaults.partitionId : record.partitionId;
	const applicationName =
		record.applicationName === ""
			? defaults.applicationName
			: record.applicationName;
	if (!APPLICATION_NAME.test(applicationName)) {
		throw new StoragePostgresError(
			"invalid-config",
			`applicationName must match ${APPLICATION_NAME.source}`,
		);
	}
	const minServerMajorVersion = within(
		record.minServerMajorVersion,
		defaults.minServerMajorVersion,
		16,
		1_000,
		"minServerMajorVersion",
	);
	const config = {
		connectionString: record.connectionString,
		schema,
		partitionId,
		poolSize: within(record.poolSize, defaults.poolSize, 1, 100, "poolSize"),
		statementTimeoutMs: within(
			record.statementTimeoutMs,
			defaults.statementTimeoutMs,
			100,
			60_000,
			"statementTimeoutMs",
		),
		connectionTimeoutMs: within(
			record.connectionTimeoutMs,
			defaults.connectionTimeoutMs,
			100,
			60_000,
			"connectionTimeoutMs",
		),
		minServerMajorVersion,
		leaseTtlMs: within(
			record.leaseTtlMs,
			defaults.leaseTtlMs,
			1_000,
			600_000,
			"leaseTtlMs",
		),
		applicationName,
	};
	// SAFETY: every field above was parsed or range-checked; that is the brand.
	return Object.freeze(config) as PostgresStoreConfig;
}

/**
 * Parse configuration from its JSON wire form. Unknown fields, wrong types
 * and out-of-range values are refused with `invalid-config`; zero/absent
 * fields take `POSTGRES_STORE_DEFAULTS`.
 */
export function parsePostgresStoreConfig(
	input: PostgresStoreConfigInput | JsonValue,
): PostgresStoreConfig {
	let record: PostgresStoreConfigRecord;
	try {
		// SAFETY: fromJson validates every field against the generated schema.
		record = fromJson(PostgresStoreConfigRecordSchema, input as JsonValue);
	} catch (error) {
		throw new StoragePostgresError(
			"invalid-config",
			`invalid storage-postgres configuration: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return refine(record);
}

/** Read configuration from environment variables (`HOBO_STORE_POSTGRES_*`). */
export function postgresStoreConfigFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): PostgresStoreConfig {
	const input: Record<string, string | number> = {};
	const text = (name: string, key: string) => {
		const value = env[name];
		if (value !== undefined && value !== "") input[key] = value;
	};
	const int = (name: string, key: string) => {
		const value = env[name];
		if (value === undefined || value === "") return;
		if (!/^[0-9]+$/u.test(value)) {
			throw new StoragePostgresError(
				"invalid-config",
				`${name} must be a non-negative integer; received ${JSON.stringify(value)}`,
			);
		}
		input[key] = Number(value);
	};
	text("HOBO_STORE_POSTGRES_URL", "connectionString");
	text("HOBO_STORE_POSTGRES_SCHEMA", "schema");
	text("HOBO_STORE_POSTGRES_PARTITION", "partitionId");
	int("HOBO_STORE_POSTGRES_POOL_SIZE", "poolSize");
	int("HOBO_STORE_POSTGRES_STATEMENT_TIMEOUT_MS", "statementTimeoutMs");
	int("HOBO_STORE_POSTGRES_CONNECTION_TIMEOUT_MS", "connectionTimeoutMs");
	int("HOBO_STORE_POSTGRES_LEASE_TTL_MS", "leaseTtlMs");
	const config = parsePostgresStoreConfig(input);
	if (config.connectionString === "") {
		throw new StoragePostgresError(
			"invalid-config",
			"HOBO_STORE_POSTGRES_URL is required",
		);
	}
	return config;
}

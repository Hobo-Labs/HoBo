/**
 * `postgres.database({ ... })` — the Bindle-facing authoring surface.
 *
 * Nothing in this file may name a provider or a product. A requirement is a
 * semantic ask: `postgres.database({ version: ">=16", extensions: ["vector"] })`
 * says what the application needs, and Matching decides who supplies it. The
 * moment a product identifier appears here, every Bindle written against it
 * stops being portable, so option keys are screened as well as values.
 */
import {
	type CapabilityRequirement,
	type CapabilityRequirementInput,
	parseCapabilityRequirement,
	type StructuredFeatureRequirementInput,
} from "@hobo/capability-profiles";

import {
	POSTGRES_CONNECTIVITY_TRANSPORTS,
	POSTGRES_GUARANTEES,
	POSTGRES_ISOLATION_LEVELS,
	POSTGRES_MIGRATION_TOOLS,
	type PostgresConnectivityTransport,
	type PostgresIsolationLevel,
	type PostgresMigrationTool,
} from "./capabilities.js";
import { PostgresDataError } from "./errors.js";
import {
	POSTGRES_MIGRATION_PROFILES,
	type PostgresMigrationProfileId,
} from "./migration-profiles.js";

// public-contract: stable capability profile identifier used across packages.
export const POSTGRES_PROFILE_ID = "data.postgres/v1" as const;
// public-contract: stable relational fallback profile identifier.
export const RELATIONAL_PROFILE_ID = "data.relational/v1" as const;

export type PostgresMigrationRequirement = {
	/** Migration profiles the product must implement, e.g. pg-dump. */
	readonly profiles?: readonly PostgresMigrationProfileId[];
	/** Tools whose compatibility the product must have proven. */
	readonly tools?: readonly PostgresMigrationTool[];
	/** Require a full logical export path out of the product. */
	readonly requireExport?: boolean;
	/** Require the product to accept a logical import. */
	readonly requireImport?: boolean;
	/** Require publications/subscriptions for a zero-downtime copy. */
	readonly requireLogicalReplication?: boolean;
};

export type PostgresDatabaseOptions = {
	/** Server major version range, e.g. `">=16"`, `"16"`, `"=17"`. */
	readonly version?: string;
	/** Extensions the schema depends on, e.g. `["vector"]`. */
	readonly extensions?: readonly string[];
	readonly migration?: PostgresMigrationRequirement;
	/** Isolation levels the application relies on being honoured. */
	readonly isolation?: readonly PostgresIsolationLevel[];
	/** Require a pooled endpoint. */
	readonly pooling?: boolean;
	/** Minimum concurrent client connections. */
	readonly minConnections?: number;
	/** Transports the consuming workload can actually open. */
	readonly connectivity?: readonly PostgresConnectivityTransport[];
	/** Require the binary `jsonb` type rather than text JSON. */
	readonly jsonb?: boolean;
	/** Minimum stored bytes the product must allow. */
	readonly minStorageBytes?: number;
	/** Runtime models the consuming Bindle may be placed on. */
	readonly runtime?: CapabilityRequirementInput["runtime"];
	/** Locator for the trust evidence this requirement should be judged under. */
	readonly trustRef?: string;
};

/**
 * Guarantees every `postgres.database()` requirement asserts.
 *
 * All seven are required rather than optional because each one is load-bearing
 * for HoBo specifically: without `connectionUriBinding` there is nothing to
 * deposit into secret custody, and without `ddl` a migration tool cannot own
 * the schema. A product that merely speaks the protocol over a read-only HTTP
 * shim is a real thing, and it is not what this authoring call asks for.
 */
export const POSTGRES_REQUIRED_GUARANTEE_KEYS: readonly string[] =
	POSTGRES_GUARANTEES.map((guarantee) => guarantee.key);

const PROVIDER_NEUTRALITY_KEY =
	/(provider|vendor|product|account|tenant|region)/iu;
const KNOWN_OPTION_KEYS: ReadonlySet<string> = new Set([
	"version",
	"extensions",
	"migration",
	"isolation",
	"pooling",
	"minConnections",
	"connectivity",
	"jsonb",
	"minStorageBytes",
	"runtime",
	"trustRef",
]);

const EXTENSION_NAME = /^[a-z_][a-z0-9_-]{0,62}$/u;

function invalid(
	message: string,
	detail?: Record<string, string | number>,
): never {
	throw new PostgresDataError(
		"INVALID_POSTGRES_REQUIREMENT",
		message,
		detail === undefined ? {} : { detail },
	);
}

type ParsedVersion = {
	readonly operator: "at-least" | "equals" | "at-most";
	readonly major: number;
};
type MutableCapabilityRequirementInput = {
	-readonly [Key in keyof CapabilityRequirementInput]: CapabilityRequirementInput[Key];
};

/**
 * Reduce a version range to an integer comparison.
 *
 * The profile records `serverVersion` as a semver range for humans and for
 * ranking; a gate has to be a number, so a range collapses to an operator plus
 * a major. `">16"` becomes `at-least 17` rather than a second operator, which
 * keeps the matcher's vocabulary small.
 */
export function parsePostgresVersionRange(range: string): ParsedVersion {
	const trimmed = range.trim();
	const match = /^([><]=?|=|\^|~)?\s*v?(\d{1,3})(?:\.\d{1,3}){0,2}$/u.exec(
		trimmed,
	);
	if (match === null) {
		invalid(
			`postgres version ${JSON.stringify(range)} must be a major version with an optional range operator, e.g. ">=16"`,
		);
	}
	const major = Number(match[2]);
	if (major < 1 || major > 999) {
		invalid(`postgres major version ${major} is out of range`);
	}
	switch (match[1]) {
		case ">":
			return { operator: "at-least", major: major + 1 };
		case "<":
			return { operator: "at-most", major: major - 1 };
		case "<=":
			return { operator: "at-most", major };
		case "=":
			return { operator: "equals", major };
		default:
			return { operator: "at-least", major };
	}
}

function assertMember<T extends string>(
	values: readonly string[],
	domain: readonly T[],
	what: string,
): readonly T[] {
	const unique: T[] = [];
	for (const value of values) {
		// SAFETY: domain is the closed string projection used for runtime membership.
		if (!(domain as readonly string[]).includes(value)) {
			invalid(`${what} ${JSON.stringify(value)} is not a recognized value`);
		}
		// SAFETY: membership in the closed `domain` above proves this value is T.
		// SAFETY: membership in the closed `domain` above proves this value is T.
		const typed = value as T;
		if (!unique.includes(typed)) unique.push(typed);
	}
	if (unique.length === 0) invalid(`${what} list must not be empty`);
	return [...unique].sort((a, b) => a.localeCompare(b));
}

function assertPositiveInteger(value: number, what: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		invalid(`${what} must be a positive integer`);
	}
	return value;
}

/**
 * Build the `data.postgres/v1` capability requirement.
 *
 * The returned value is canonically ordered by `parseCapabilityRequirement`, so
 * two authors who write the same intent in a different order produce the same
 * selection decision and the same receipt.
 */
export function database(
	options: PostgresDatabaseOptions = {},
): CapabilityRequirement {
	for (const key of Object.keys(options)) {
		if (!KNOWN_OPTION_KEYS.has(key)) {
			invalid(`unknown postgres.database option ${JSON.stringify(key)}`);
		}
		if (PROVIDER_NEUTRALITY_KEY.test(key)) {
			invalid(
				`postgres.database must stay provider-neutral; ${JSON.stringify(key)} names placement, not capability`,
			);
		}
	}

	const features: StructuredFeatureRequirementInput[] = [];

	if (options.version !== undefined) {
		const parsed = parsePostgresVersionRange(options.version);
		features.push({
			key: "serverVersionMajor",
			operator: parsed.operator,
			value: parsed.major,
			necessity: "required",
		});
	}

	if (options.extensions !== undefined) {
		if (options.extensions.length === 0) {
			invalid("extensions must not be an empty list; omit the option instead");
		}
		for (const extension of options.extensions) {
			if (!EXTENSION_NAME.test(extension)) {
				invalid(
					`extension ${JSON.stringify(extension)} is not a plain PostgreSQL extension name`,
				);
			}
		}
		features.push({
			key: "extensions",
			operator: "includes-all",
			value: [...options.extensions].sort((a, b) => a.localeCompare(b)),
			necessity: "required",
		});
	}

	if (options.isolation !== undefined) {
		features.push({
			key: "isolationLevels",
			operator: "includes-all",
			value: assertMember(
				options.isolation,
				POSTGRES_ISOLATION_LEVELS,
				"isolation level",
			),
			necessity: "required",
		});
	}

	if (options.connectivity !== undefined) {
		features.push({
			key: "connectivityTransports",
			operator: "includes-all",
			value: assertMember(
				options.connectivity,
				POSTGRES_CONNECTIVITY_TRANSPORTS,
				"connectivity transport",
			),
			necessity: "required",
		});
	}

	if (options.pooling === true) {
		features.push({
			key: "pooling",
			operator: "equals",
			value: true,
			necessity: "required",
		});
	}

	if (options.jsonb === true) {
		features.push({
			key: "jsonb",
			operator: "equals",
			value: true,
			necessity: "required",
		});
	}

	if (options.minConnections !== undefined) {
		features.push({
			key: "maxConnections",
			operator: "at-least",
			value: assertPositiveInteger(options.minConnections, "minConnections"),
			necessity: "required",
		});
	}

	if (options.minStorageBytes !== undefined) {
		features.push({
			key: "maxStorageBytes",
			operator: "at-least",
			value: assertPositiveInteger(options.minStorageBytes, "minStorageBytes"),
			necessity: "required",
		});
	}

	const migration = options.migration;
	if (migration?.tools !== undefined) {
		features.push({
			key: "migrationToolCompatibility",
			operator: "includes-all",
			value: assertMember(
				migration.tools,
				POSTGRES_MIGRATION_TOOLS,
				"migration tool",
			),
			necessity: "required",
		});
	}
	if (migration?.requireExport === true) {
		features.push({
			key: "exportSupported",
			operator: "equals",
			value: true,
			necessity: "required",
		});
	}
	if (migration?.requireImport === true) {
		features.push({
			key: "importSupported",
			operator: "equals",
			value: true,
			necessity: "required",
		});
	}
	if (migration?.requireLogicalReplication === true) {
		features.push({
			key: "logicalReplication",
			operator: "equals",
			value: true,
			necessity: "required",
		});
	}

	const requiredMigrationProfiles = migration?.profiles ?? [];
	for (const profile of requiredMigrationProfiles) {
		// SAFETY: the closed profile list is the runtime validator for this input.
		if (!(POSTGRES_MIGRATION_PROFILES as readonly string[]).includes(profile)) {
			invalid(`unknown postgres migration profile ${JSON.stringify(profile)}`);
		}
	}

	const requirementInput: MutableCapabilityRequirementInput = {
		requiredProfiles: [{ profileId: POSTGRES_PROFILE_ID, versionRange: ">=1" }],
		features,
		guarantees: POSTGRES_REQUIRED_GUARANTEE_KEYS.map((key) => ({
			key,
			operator: "equals" as const,
			value: true,
		})),
		portability: {
			requireStandardBinding: true,
			requireExportProfile: migration?.requireExport ?? false,
			requiredMigrationProfiles,
		},
	};
	if (options.runtime !== undefined) requirementInput.runtime = options.runtime;
	if (options.trustRef !== undefined)
		requirementInput.trustRef = options.trustRef;
	return parseCapabilityRequirement(requirementInput);
}

/**
 * Namespaced authoring entry point so a Bindle reads
 * `postgres.database({ ... })` rather than a bare `database(...)`.
 */
export const postgres = { database } as const;

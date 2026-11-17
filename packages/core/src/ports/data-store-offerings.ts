import { CoreParseError } from "../errors.js";
import { cloneAsJson, isJsonString, type JsonValue } from "../json.js";
import { deepFreeze, enumValue, expectObject } from "../parse-utils.js";
import {
	matchResourceOfferings,
	type OfferingFidelity,
	type OfferingStability,
	type ResourceOffering,
	type ResourceOfferingMatch,
	type ResourceOfferingProfile,
	type ResourceOfferingRequest,
	type ResourceOfferingResolveResult,
	resolveResourceOfferings,
} from "./offering-resolution.js";

export type DataStoreOfferingId =
	| "sql.relational"
	| "sql.transactions"
	| "kv.point"
	| "blob.object"
	| "journal.event-stream"
	| "cdc.stream"
	| "replica.read"
	| "backup.pitr"
	| "migrate.dual-write"
	| "observe.lag"
	| "replica.multi-region"
	| "write.multi-writer"
	| "ha.failover"
	| "replicate.logical-publish"
	| "replicate.logical-subscribe"
	| "pool.transaction"
	| "auth.password"
	| "auth.identity-token"
	| "tls.public-ca";

export type DataStoreProvider =
	| "sqlite-local"
	| "cloudflare-d1"
	| "supabase-postgres"
	| "aws-rds"
	| "gcp-cloudsql"
	| "azure-sql"
	| "neon-postgres"
	| "prisma-postgres"
	| "pgedge-cloud"
	| "planetscale-postgres"
	| "azure-postgres-flexible"
	| "azure-horizondb"
	| "aws-rds-postgres"
	| "aws-aurora-postgres"
	| "gcp-cloudsql-postgres"
	| "gcp-alloydb"
	| "self-hosted-postgres"
	| "other";

export const DATA_STORE_ENGINES = Object.freeze([
	"sqlite",
	"postgres",
	"sqlserver",
	"mysql",
	"mongodb",
	"other",
] as const);

export type DataStoreEngine = (typeof DATA_STORE_ENGINES)[number];

const PROVIDER_ENGINES: Readonly<Record<DataStoreProvider, DataStoreEngine>> =
	Object.freeze({
		"sqlite-local": "sqlite",
		"cloudflare-d1": "sqlite",
		"supabase-postgres": "postgres",
		"aws-rds": "other",
		"gcp-cloudsql": "other",
		"azure-sql": "sqlserver",
		"neon-postgres": "postgres",
		"prisma-postgres": "postgres",
		"pgedge-cloud": "postgres",
		"planetscale-postgres": "postgres",
		"azure-postgres-flexible": "postgres",
		"azure-horizondb": "postgres",
		"aws-rds-postgres": "postgres",
		"aws-aurora-postgres": "postgres",
		"gcp-cloudsql-postgres": "postgres",
		"gcp-alloydb": "postgres",
		"self-hosted-postgres": "postgres",
		other: "other",
	});

export function engineOfDataStoreProvider(
	provider: DataStoreProvider,
): DataStoreEngine {
	return PROVIDER_ENGINES[provider];
}

export type DataStoreOffering = ResourceOffering<DataStoreOfferingId>;

export type DataStoreProviderProfile = ResourceOfferingProfile<
	DataStoreOfferingId,
	DataStoreProvider
>;

export interface DataStorePortRequest
	extends ResourceOfferingRequest<DataStoreOfferingId> {}

export type DataStoreMatch = ResourceOfferingMatch<DataStoreOfferingId>;

export type DataStoreResolveResult = ResourceOfferingResolveResult<
	DataStoreOfferingId,
	DataStoreProvider
>;

export class DataStoreOfferingParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super(
			"HOBO_CORE_DATA_STORE_OFFERING_PARSE",
			path,
			expected,
			received,
			message,
		);
		this.name = "DataStoreOfferingParseError";
	}
}

const OFFERINGS = new Set<DataStoreOfferingId>([
	"sql.relational",
	"sql.transactions",
	"kv.point",
	"blob.object",
	"journal.event-stream",
	"cdc.stream",
	"replica.read",
	"backup.pitr",
	"migrate.dual-write",
	"observe.lag",
	"replica.multi-region",
	"write.multi-writer",
	"ha.failover",
	"replicate.logical-publish",
	"replicate.logical-subscribe",
	"pool.transaction",
	"auth.password",
	"auth.identity-token",
	"tls.public-ca",
]);

const PROVIDERS = new Set<DataStoreProvider>([
	"sqlite-local",
	"cloudflare-d1",
	"supabase-postgres",
	"aws-rds",
	"gcp-cloudsql",
	"azure-sql",
	"neon-postgres",
	"prisma-postgres",
	"pgedge-cloud",
	"planetscale-postgres",
	"azure-postgres-flexible",
	"azure-horizondb",
	"aws-rds-postgres",
	"aws-aurora-postgres",
	"gcp-cloudsql-postgres",
	"gcp-alloydb",
	"self-hosted-postgres",
	"other",
]);

// public-contract: every id the data-store vocabulary accepts, in declaration order.
export const DATA_STORE_OFFERING_IDS: readonly DataStoreOfferingId[] =
	Object.freeze([...OFFERINGS]);

// public-contract: every provider id the data-store vocabulary accepts.
export const DATA_STORE_PROVIDERS: readonly DataStoreProvider[] = Object.freeze(
	[...PROVIDERS],
);

// public-contract: backward-compatibility map from product ids to the original family ids.
export const DATA_STORE_PROVIDER_FAMILIES = Object.freeze({
	"aws-rds-postgres": "aws-rds",
	"gcp-cloudsql-postgres": "gcp-cloudsql",
} as const satisfies Partial<Record<DataStoreProvider, DataStoreProvider>>);

const STABILITIES = new Set<OfferingStability>([
	"stable",
	"preview",
	"experimental",
]);

const FIDELITIES = new Set<OfferingFidelity>([
	"real",
	"simulated",
	"mocked",
	"camp-only",
]);

export const DEFAULT_DATA_STORE_FALLBACKS: readonly DataStoreOfferingId[] = [
	"journal.event-stream",
	"cdc.stream",
	"migrate.dual-write",
];

// public-contract: registry key consumers use to register/resolve this class.
export const DATA_STORE_RESOURCE_CLASS = "data-store";

export function parseDataStoreOfferingId(
	value: JsonValue | undefined,
	path = "offeringId",
): DataStoreOfferingId {
	return enumValue(value, OFFERINGS, path, DataStoreOfferingParseError);
}

export function parseDataStoreProvider(
	value: JsonValue | undefined,
	path = "provider",
): DataStoreProvider {
	return enumValue(value, PROVIDERS, path, DataStoreOfferingParseError);
}

export function parseDataStoreOffering(
	value: JsonValue | undefined,
	path = "offering",
): DataStoreOffering {
	const input = expectObject(value, path, DataStoreOfferingParseError);
	return deepFreeze({
		id: parseDataStoreOfferingId(input.id, `${path}.id`),
		stability: parseDataStoreStability(input.stability, `${path}.stability`),
		fidelity: parseDataStoreFidelity(input.fidelity, `${path}.fidelity`),
		features: parseDataStoreFeatures(input.features, `${path}.features`),
	});
}

export function parseDataStoreStability(
	value: JsonValue | undefined,
	path = "stability",
): OfferingStability {
	return enumValue(
		value ?? "stable",
		STABILITIES,
		path,
		DataStoreOfferingParseError,
	);
}

export function parseDataStoreFidelity(
	value: JsonValue | undefined,
	path = "fidelity",
): OfferingFidelity {
	return enumValue(
		value ?? "real",
		FIDELITIES,
		path,
		DataStoreOfferingParseError,
	);
}

export function parseDataStoreFeatures(
	value: JsonValue | undefined,
	path = "features",
): readonly string[] {
	if (!Array.isArray(value)) return deepFreeze([]);
	return deepFreeze(
		value.map((feature, index) => {
			if (!isJsonString(feature) || feature.trim().length === 0) {
				throw new DataStoreOfferingParseError(
					`${path}[${index}]`,
					"non-empty string",
					feature,
				);
			}
			return feature.trim();
		}),
	);
}

export function parseDataStoreProviderProfile(
	value: JsonValue | undefined,
	path = "profile",
): DataStoreProviderProfile {
	const input = expectObject(value, path, DataStoreOfferingParseError);
	const offerings = (
		Array.isArray(input.offerings)
			? input.offerings
			: fail(path, "offerings array", input.offerings)
	).map((entry, index) =>
		parseDataStoreOffering(entry, `${path}.offerings[${index}]`),
	);
	const ids = new Set(offerings.map((entry) => entry.id));
	if (ids.size !== offerings.length) {
		fail(`${path}.offerings`, "unique offering ids", input.offerings);
	}
	const fallbacks = Array.isArray(input.fallbacks)
		? input.fallbacks.map((entry, index) =>
				parseDataStoreOfferingId(entry, `${path}.fallbacks[${index}]`),
			)
		: [...DEFAULT_DATA_STORE_FALLBACKS];
	return deepFreeze({
		provider: parseDataStoreProvider(input.provider, `${path}.provider`),
		offerings,
		fallbacks: deepFreeze(fallbacks),
	});
}

export function matchDataStoreOfferings(
	profile: DataStoreProviderProfile,
	request: DataStorePortRequest = {},
): DataStoreMatch {
	return matchResourceOfferings(DATA_STORE_RESOURCE_CLASS, profile, request);
}

export function resolveDataStore(
	profiles: readonly DataStoreProviderProfile[],
	request: DataStorePortRequest = {},
): DataStoreResolveResult {
	return resolveResourceOfferings(
		DATA_STORE_RESOURCE_CLASS,
		profiles,
		request,
		{ defaultMissing: ["sql.relational"] },
	);
}

export function dataStoreOffering(
	id: DataStoreOfferingId,
	options: {
		readonly stability?: OfferingStability;
		readonly fidelity?: OfferingFidelity;
		readonly features?: readonly string[];
	} = {},
): DataStoreOffering {
	return deepFreeze({
		id,
		stability: options.stability ?? "stable",
		fidelity: options.fidelity ?? "real",
		features: deepFreeze([...(options.features ?? [])]),
	});
}

function fail<T>(path: string, expected: string, received: T): never {
	throw new DataStoreOfferingParseError(path, expected, cloneAsJson(received));
}

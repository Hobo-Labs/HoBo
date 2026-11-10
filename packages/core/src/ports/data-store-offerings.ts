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

/**
 * Portable data-store offerings — the first non-routing vocabulary bound to
 * the generic per-resource-class resolver (plan-25 Resource Definition
 * Matching). Providers declare what their stores natively realize; the
 * portable fallback ladder covers what the platform can realize on top of any
 * store (journal-backed CDC, trail-driven dual writes — ADR-0032/0135).
 */
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
	| "observe.lag";

export type DataStoreProvider =
	| "sqlite-local"
	| "cloudflare-d1"
	| "supabase-postgres"
	| "aws-rds"
	| "gcp-cloudsql"
	| "azure-sql"
	| "other";

/**
 * The storage engine behind a data store (ADR-0177).
 *
 * `DataStoreProvider` above names *products*. An engine is a different fact
 * with a different owner: wire protocol, type system, DDL semantics, and
 * replication mechanism are properties of the engine, shared by every product
 * of it. The migration patterns a store can take part in are decided by its
 * engine; what a particular product then disables is a narrowing on top.
 */
export const DATA_STORE_ENGINES = Object.freeze([
	"sqlite",
	"postgres",
	"sqlserver",
	"mysql",
	"mongodb",
	"other",
] as const);

export type DataStoreEngine = (typeof DATA_STORE_ENGINES)[number];

/** Which engine each known product is. `other` is honest: nothing is assumed. */
const PROVIDER_ENGINES: Readonly<Record<DataStoreProvider, DataStoreEngine>> =
	Object.freeze({
		"sqlite-local": "sqlite",
		// D1 speaks the SQLite dialect; it is not a Postgres and never satisfies one.
		"cloudflare-d1": "sqlite",
		"supabase-postgres": "postgres",
		// These three name a managed *service* that hosts more than one engine,
		// so the product id alone does not determine the engine.
		"aws-rds": "other",
		"gcp-cloudsql": "other",
		"azure-sql": "sqlserver",
		other: "other",
	});

/**
 * The engine a product is, when the product id determines it. Returns `other`
 * for a product that hosts several engines — the caller must then read the
 * engine from the product's declaration rather than guess.
 */
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
]);

const PROVIDERS = new Set<DataStoreProvider>([
	"sqlite-local",
	"cloudflare-d1",
	"supabase-postgres",
	"aws-rds",
	"gcp-cloudsql",
	"azure-sql",
	"other",
]);

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

/**
 * Default portable fallback ladder: realizable on top of any store the
 * platform journals — CDC via journal tailing, dual writes via trails.
 */
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
	const features = Array.isArray(input.features)
		? input.features.map((feature, index) => {
				if (!isJsonString(feature) || feature.trim().length === 0) {
					throw new DataStoreOfferingParseError(
						`${path}.features[${index}]`,
						"non-empty string",
						feature,
					);
				}
				return feature.trim();
			})
		: [];
	return deepFreeze({
		id: parseDataStoreOfferingId(input.id, `${path}.id`),
		stability: enumValue(
			input.stability ?? "stable",
			STABILITIES,
			`${path}.stability`,
			DataStoreOfferingParseError,
		),
		fidelity: enumValue(
			input.fidelity ?? "real",
			FIDELITIES,
			`${path}.fidelity`,
			DataStoreOfferingParseError,
		),
		features: deepFreeze(features),
	});
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

/** Match a data-store request against one provider profile. */
export function matchDataStoreOfferings(
	profile: DataStoreProviderProfile,
	request: DataStorePortRequest = {},
): DataStoreMatch {
	return matchResourceOfferings(DATA_STORE_RESOURCE_CLASS, profile, request);
}

/** Resolve a data-store request against candidate provider profiles. */
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

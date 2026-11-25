/**
 * The gate that matters: a relational database is not a PostgreSQL database.
 * Every case is a line in `profile-matching.cases.jsonl`.
 *
 * Candidates are shaped like real products but constructed locally — this
 * package must never import a provider, and a test that did would make the
 * provider-neutrality claim untestable. A case names a candidate, or patches
 * one, so the shapes stay here and the scenarios stay data.
 */
import {
	createCapabilityProfileRegistry,
	type SelectionCandidate,
	STANDARD_CAPABILITY_PROFILES,
	type StructuredCapabilityValue,
	selectCapabilityImplementation,
	type TrustPolicy,
} from "@hobo/capability-profiles";
import { describeConcern } from "@hobo/contract-harness";
import {
	POSTGRES_REQUIRED_GUARANTEE_KEYS,
	postgres,
	postgresConformanceRef,
} from "../src/index.js";

const registry = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
const NOW = Date.UTC(2026, 7, 8);

const policy: TrustPolicy = {
	minimumProviderClass: "experimental",
	creatorAuthorityAfterClaim: "may-be-retained",
	maximumClaimActions: 4,
	maximumEvidenceAgeMs: 90 * 24 * 60 * 60 * 1000,
	requireExportProfile: false,
	allowSponsor: true,
	allowPack: true,
	allowBridge: true,
	sponsorBudgetMinorUnits: 0,
};

/** The guarantees every conformant Postgres product asserts. */
const GUARANTEED = Object.fromEntries(
	POSTGRES_REQUIRED_GUARANTEE_KEYS.map((key) => [key, true]),
);

const BASE_CAPABILITIES = {
	...GUARANTEED,
	serverVersion: ">=17",
	serverVersionMajor: 17,
	jsonDocuments: true,
	jsonb: true,
	preparedStatements: true,
	pooling: true,
	isolationLevels: ["read-committed", "repeatable-read", "serializable"],
	migrationToolCompatibility: [
		"pg-dump",
		"pg-restore",
		"psql",
		"prisma-migrate",
	],
	connectivityTransports: ["tcp", "tls-tcp"],
	exportSupported: true,
	importSupported: true,
	credentialRotation: "provider-console",
};

function candidate(
	overrides: Partial<SelectionCandidate> & {
		definitionId: string;
		providerId: string;
	},
): SelectionCandidate {
	// SAFETY: this fixture supplies every required SelectionCandidate field below.
	return {
		implementsProfiles: [
			{
				profileId: "data.postgres/v1",
				versionRange: ">=1",
				realization: "native",
				conformanceRef: postgresConformanceRef(
					overrides.definitionId.split("/")[0] ?? "x",
					"2026-08-08",
				),
				conformance: "pass",
			},
		],
		runtimeModels: ["paas", "serverless_faas", "oci"],
		structuredCapabilities: BASE_CAPABILITIES,
		producesBindingProfiles: ["binding.postgresql/v1"],
		migrationProfiles: ["migration.postgres.pg-dump/v1"],
		providerClass: "verified-emerging",
		evidenceExpiresAtMs: NOW + 30 * 24 * 60 * 60 * 1000,
		evidenceSignatureValid: true,
		creatorAuthorityAfterClaim: "rotatable",
		claimAtomicity: "single-resource",
		claimActionCount: 1,
		continuity: {
			endpoint: "preserved",
			data: "preserved",
			credentials: "retained",
		},
		supportsExport: true,
		supportsRotation: true,
		supportsRevocation: true,
		sponsorExposureMinorUnits: 0,
		hasRegisteredDriver: true,
		secretCustodyAvailable: true,
		...overrides,
		// SAFETY: this fixture supplies every required SelectionCandidate field above.
	} as SelectionCandidate;
}

/** Neon Claimable Postgres: real Postgres, pooled, exportable. */
const neon = candidate({
	definitionId: "neon.claimable-postgres/v1",
	providerId: "neon",
	structuredCapabilities: {
		...BASE_CAPABILITIES,
		extensions: ["vector", "pg_trgm"],
		logicalReplication: true,
		maxStorageBytes: 100 * 1024 * 1024,
	},
	migrationProfiles: [
		"migration.postgres.pg-dump/v1",
		"migration.postgres.logical-copy/v1",
	],
});

/** Prisma's create-db temporary Postgres. Never declares `extensions`. */
const prisma = candidate({
	definitionId: "prisma.claimable-postgres/v1",
	providerId: "prisma",
});

/** A D1 / SQLite-class product: relational, transactional, not PostgreSQL. */
const sqlite = candidate({
	definitionId: "cloudflare.temporary-d1/v1",
	providerId: "cloudflare",
	implementsProfiles: [
		{
			profileId: "data.sqlite/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: "hobo.conformance/data.sqlite/v1#d1@2026-08-08",
			conformance: "pass",
		},
	],
	structuredCapabilities: {
		transactions: true,
		constraints: true,
		jsonDocuments: true,
		sqliteDialect: true,
		exportSupported: true,
	},
	producesBindingProfiles: ["binding.http/v1"],
	migrationProfiles: [],
});

const NAMED = { neon, prisma, sqlite } as const;

type ScenarioValue =
	| boolean
	| number
	| string
	| readonly string[]
	| ScenarioOptions;
type ScenarioOptions = Readonly<Record<string, ScenarioValue>>;

type CandidateSpec =
	| keyof typeof NAMED
	| {
			readonly definitionId: string;
			readonly providerId: string;
			/** Merged over the base capability set, or over a named candidate's. */
			readonly from?: keyof typeof NAMED;
			/**
			 * Start from the bare guarantees instead of the full base set, for a
			 * product that speaks Postgres but has never proven a migration tool.
			 */
			readonly guaranteesOnly?: boolean;
			readonly structuredCapabilities?: Readonly<
				Record<string, StructuredCapabilityValue>
			>;
	  };

const resolve = (spec: CandidateSpec): SelectionCandidate => {
	// SAFETY: named fixture keys are the only keys in NAMED; object specs have definitionId.
	const named = NAMED[spec as keyof typeof NAMED];
	if (named !== undefined) return named;
	return candidate({
		definitionId: spec.definitionId,
		providerId: spec.providerId,
		structuredCapabilities: {
			...(spec.guaranteesOnly
				? GUARANTEED
				: spec.from
					? NAMED[spec.from].structuredCapabilities
					: BASE_CAPABILITIES),
			...spec.structuredCapabilities,
		},
	});
};

describeConcern("postgres profile matching", {
	cases: `${import.meta.dirname}/profile-matching.cases.jsonl`,
	subject: () => ({
		select: (ask: {
			readonly options?: ScenarioOptions;
			readonly candidates: readonly CandidateSpec[];
		}) => {
			const outcome = selectCapabilityImplementation({
				// SAFETY: JSONL scenarios intentionally exercise the runtime authoring boundary.
				requirement: postgres.database(ask.options as never),
				registry,
				candidates: ask.candidates.map(resolve),
				policy,
				nowMs: NOW,
			});
			return {
				winner: outcome.winner?.definitionId ?? null,
				ranked: outcome.ranked.map((entry) => entry.definitionId).sort(),
				rejections: outcome.rejections
					.map((rejection) => `${rejection.definitionId}:${rejection.code}`)
					.sort(),
			};
		},
		/** The parsed requirement, for the authoring-order and refusal lanes. */
		requirement: (options?: ScenarioOptions) =>
			// SAFETY: JSONL scenarios intentionally exercise the runtime authoring boundary.
			JSON.stringify(postgres.database(options as never)),
		/** Authoring order must not change the requirement. */
		isOrderIndependent: (a: ScenarioOptions, b: ScenarioOptions) =>
			// SAFETY: JSONL scenarios intentionally exercise the runtime authoring boundary.
			JSON.stringify(postgres.database(a as never)) ===
			JSON.stringify(postgres.database(b as never)),
	}),
});

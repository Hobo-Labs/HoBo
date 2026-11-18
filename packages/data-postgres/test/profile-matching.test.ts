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
	} as SelectionCandidate;
}

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

const prisma = candidate({
	definitionId: "prisma.claimable-postgres/v1",
	providerId: "prisma",
});

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
			readonly from?: keyof typeof NAMED;
			readonly guaranteesOnly?: boolean;
			readonly structuredCapabilities?: Readonly<
				Record<string, StructuredCapabilityValue>
			>;
	  };

const resolve = (spec: CandidateSpec): SelectionCandidate => {
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
		requirement: (options?: ScenarioOptions) =>
			JSON.stringify(postgres.database(options as never)),
		isOrderIndependent: (a: ScenarioOptions, b: ScenarioOptions) =>
			JSON.stringify(postgres.database(a as never)) ===
			JSON.stringify(postgres.database(b as never)),
	}),
});

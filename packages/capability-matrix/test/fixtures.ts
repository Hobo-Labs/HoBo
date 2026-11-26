/**
 * A small but honest catalog: one definition for each of the five buckets, one
 * whose evidence is about to lapse, one that names no conformance suite, one
 * legacy entry, and one claiming a profile nobody registered.
 *
 * Everything is built through the real parsers in `@hobo/capability-profiles`
 * and `@hobo/trust`, so a fixture that would be rejected in production is
 * rejected here too.
 */
import {
	type CapabilityProfileDescriptor,
	type CapabilityProfileRegistry,
	createCapabilityProfileRegistry,
	type ProfileImplementation,
} from "@hobo/capability-profiles";
import {
	computeEvidenceDigest,
	type EvidenceVerifier,
	parseTrustEvidence,
	parseTrustRequirement,
	type TrustEvidence,
	type TrustEvidenceInput,
	type TrustRequirement,
} from "@hobo/trust";

import type {
	CapabilityMatrixInput,
	RegisteredDefinition,
} from "../src/index.js";

export const DAY = 24 * 60 * 60 * 1000;
export const NOW = Date.UTC(2026, 7, 8);

/** Trusts every signature, so the tests exercise coverage rather than crypto. */
export const TEST_VERIFIER: EvidenceVerifier = {
	id: "test.trust-root/v1",
	verify: () => "valid",
};

/**
 * Packs, bridges and sponsorship are all permitted, because the point of these
 * tests is that the matrix reports them *separately*, not that a policy hides
 * them.
 */
export const TEST_REQUIREMENT: TrustRequirement = parseTrustRequirement({
	minimumProviderClass: "experimental",
	requireOfficialBootstrapContract: true,
	requireDocumentedClaimContract: true,
	creatorAuthorityAfterClaim: "must-be-rotatable",
	maximumClaimActions: 2,
	maximumEvidenceAgeMs: 30 * DAY,
	allowSponsor: true,
	allowPack: true,
	allowBridge: true,
});

function profile(
	id: string,
	primitive: CapabilityProfileDescriptor["primitive"],
): CapabilityProfileDescriptor {
	return {
		schemaVersion: "hobo.capability-profile/v1",
		id,
		primitive,
		displayName: id,
		description: `test profile ${id}`,
		refines: [],
		requirementSchemaRef: `${id}#requirement`,
		conformanceSuiteRef: `${id}#conformance`,
		features: [],
		guarantees: [],
		maturity: "stable",
		sourceRefs: [
			{ url: "https://example.invalid/spec", checkedAt: "2026-07-01" },
		],
	};
}

export const PROFILE_REGISTRY: CapabilityProfileRegistry =
	createCapabilityProfileRegistry([
		profile("data.postgres/v1", "data"),
		profile("kv.redis-compatible/v1", "kv"),
		profile("bucket.object-store/v1", "bucket"),
		profile("queue.fifo/v1", "queue"),
	]);

function evidence(options: {
	readonly providerId: string;
	readonly definitionId: string;
	readonly expiresAt: number;
	readonly sponsorBacked: boolean;
}): TrustEvidence {
	const draft: TrustEvidenceInput = {
		schemaVersion: "hobo.trust-evidence/v1",
		providerId: options.providerId,
		productDefinitionId: options.definitionId,
		adapterVersion: "1.0.0",
		providerClass: "established",
		testedAt: NOW - DAY,
		expiresAt: options.expiresAt,
		checks: {
			"bootstrap.official-contract": "pass",
			"claim.documented-contract": "pass",
			"conformance.suite": "pass",
		},
		creatorAuthorityAfterClaim: "rotatable",
		claimActionCount: 1,
		sponsorBacked: options.sponsorBacked,
		evidenceDigest: "sha256:0",
		signature: "test-signature",
		sourceRefs: [
			{ url: "https://example.invalid/evidence", checkedAt: "2026-08-01" },
		],
	};
	return parseTrustEvidence({
		...draft,
		evidenceDigest: computeEvidenceDigest(draft),
	});
}

function implementation(
	profileId: string,
	realization: ProfileImplementation["realization"],
	conformanceRef = `${profileId}#suite`,
): ProfileImplementation {
	return {
		profileId,
		versionRange: ">=1",
		realization,
		conformanceRef,
		conformance: "pass",
	};
}

export function definition(options: {
	readonly id: string;
	readonly providerId: string;
	readonly implementsProfiles: readonly ProfileImplementation[];
	readonly runtimeModels: readonly (
		| "wasm"
		| "oci"
		| "vm_iaas"
		| "paas"
		| "serverless_faas"
	)[];
	readonly sponsorExposureMinorUnits?: number;
}): RegisteredDefinition {
	return {
		id: options.id,
		providerId: options.providerId,
		semantics: {
			schemaVersion: "hobo.resource-definition/vNext",
			productId: options.id,
			displayName: options.id,
			implementsProfiles: options.implementsProfiles,
			runtimeModels: options.runtimeModels,
			structuredCapabilities: {},
			placementConstraints: [],
			producesBindingProfiles: ["binding.postgresql/v1"],
			migrationProfiles: [],
			bootstrapStrategyRef: `${options.id}#bootstrap`,
			claimStrategyRef: `${options.id}#claim`,
			compilerRef: `${options.id}#compiler`,
			executorRef: `${options.id}#executor`,
			permissionProfileRef: `${options.id}#permissions`,
			trustEvidenceRef: `${options.id}#evidence`,
			sourceEvidenceRefs: ["https://example.invalid/docs"],
			remediation: [],
			providerClass: "established",
			evidenceSignatureValid: true,
			creatorAuthorityAfterClaim: "rotatable",
			claimAtomicity: "single-resource",
			claimActionCount: 1,
			continuity: {
				endpoint: "preserved",
				data: "preserved",
				credentials: "rotated",
			},
			supportsExport: true,
			supportsRotation: true,
			supportsRevocation: true,
			sponsorExposureMinorUnits: options.sponsorExposureMinorUnits ?? 0,
			secretCustodyAvailable: true,
		},
	};
}

export const NEON = definition({
	id: "neon.claimable-postgres/v1",
	providerId: "neon",
	implementsProfiles: [implementation("data.postgres/v1", "native")],
	runtimeModels: ["paas", "serverless_faas"],
});

export const PACK = definition({
	id: "hobo.pack-postgres/v1",
	providerId: "hobo-packs",
	implementsProfiles: [implementation("data.postgres/v1", "pack")],
	runtimeModels: ["oci"],
});

export const BRIDGE = definition({
	id: "hyperdrive.postgres-bridge/v1",
	providerId: "cloudflare",
	implementsProfiles: [implementation("data.postgres/v1", "bridge")],
	runtimeModels: ["wasm"],
});

/** Native realization, but on iron HoBo runs — so it is substrate, not market. */
export const SUBSTRATE = definition({
	id: "hobo.operated-redis/v1",
	providerId: "hobo-substrate",
	implementsProfiles: [implementation("kv.redis-compatible/v1", "native")],
	runtimeModels: ["vm_iaas"],
});

/** Native realization, but HoBo pays for the bootstrap — so it is sponsored. */
export const SPONSORED = definition({
	id: "sponsored.object-store/v1",
	providerId: "sponsor-partner",
	implementsProfiles: [implementation("bucket.object-store/v1", "native")],
	runtimeModels: ["serverless_faas"],
	sponsorExposureMinorUnits: 500,
});

/** Fresh now, expired shortly after. The regression case. */
export const EXPIRING = definition({
	id: "upstash.claimable-redis/v1",
	providerId: "upstash",
	implementsProfiles: [implementation("kv.redis-compatible/v1", "native")],
	runtimeModels: ["serverless_faas"],
});

/** Claims a cell but names no suite, so the claim cannot be checked. */
export const UNPROVEN = definition({
	id: "unproven.object-store/v1",
	providerId: "unproven",
	implementsProfiles: [implementation("bucket.object-store/v1", "native", "")],
	runtimeModels: ["oci"],
});

/** Claims a profile nobody registered, so it reaches no cell. */
export const GHOST = definition({
	id: "ghost.queue/v1",
	providerId: "ghost",
	implementsProfiles: [implementation("queue.unregistered/v1", "native")],
	runtimeModels: ["oci"],
});

/** A pre-vNext catalog entry: no semantics, therefore no capability claim. */
export const LEGACY: RegisteredDefinition = {
	id: "legacy.port-matched/v1",
	providerId: "legacy",
};

export const DEFINITIONS: readonly RegisteredDefinition[] = [
	NEON,
	PACK,
	BRIDGE,
	SUBSTRATE,
	SPONSORED,
	EXPIRING,
	UNPROVEN,
	GHOST,
	LEGACY,
];

export const TRUST_EVIDENCE: ReadonlyMap<string, TrustEvidence> = new Map(
	[
		{ definition: NEON, expiresAt: NOW + 30 * DAY, sponsorBacked: false },
		{ definition: PACK, expiresAt: NOW + 30 * DAY, sponsorBacked: false },
		{ definition: BRIDGE, expiresAt: NOW + 30 * DAY, sponsorBacked: false },
		{ definition: SUBSTRATE, expiresAt: NOW + 30 * DAY, sponsorBacked: false },
		{ definition: SPONSORED, expiresAt: NOW + 30 * DAY, sponsorBacked: true },
		// Two days of validity left: fresh today, gone by Tuesday.
		{ definition: EXPIRING, expiresAt: NOW + 2 * DAY, sponsorBacked: false },
		{ definition: UNPROVEN, expiresAt: NOW + 30 * DAY, sponsorBacked: false },
		{ definition: GHOST, expiresAt: NOW + 30 * DAY, sponsorBacked: false },
	].map((entry) => {
		const ref =
			entry.definition.semantics?.trustEvidenceRef ?? entry.definition.id;
		return [
			ref,
			evidence({
				providerId: entry.definition.providerId,
				definitionId: entry.definition.id,
				expiresAt: entry.expiresAt,
				sponsorBacked: entry.sponsorBacked,
			}),
		] as const;
	}),
);

export function matrixInput(
	overrides: Partial<CapabilityMatrixInput> = {},
): CapabilityMatrixInput {
	return {
		definitions: DEFINITIONS,
		profileRegistry: PROFILE_REGISTRY,
		trustEvidence: TRUST_EVIDENCE,
		nowMs: NOW,
		requirement: TEST_REQUIREMENT,
		verifier: TEST_VERIFIER,
		hoboOperatedProviderIds: ["hobo-substrate"],
		...overrides,
	};
}

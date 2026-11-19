import type { SelectionCandidate } from "@hobo/capability-profiles";
import {
	type PackSemanticsOptions,
	toPackSelectionCandidate,
	type VerifiedPackManifest,
} from "@hobo/pack-framework";

import { VALKEY_SERVER_MAJOR, VALKEY_SERVER_VERSION } from "./image.js";
import {
	type ValkeyDurabilityMode,
	type ValkeyEvictionPolicy,
	valkeyRetentionSemantics,
} from "./semantics.js";

// public-contract: stable catalog definition identifier.
export const VALKEY_PACK_DEFINITION_ID = "hobo.pack.valkey-oci/v1" as const;

export type ValkeyCatalogOptions = {
	readonly yardId: string;
	readonly evidenceExpiresAtMs: number;
	readonly evidenceSignatureValid: boolean;
	readonly durabilityMode: ValkeyDurabilityMode;
	readonly evictionPolicy: ValkeyEvictionPolicy;
	readonly maxValueBytes?: number;
	readonly tls?: boolean;
};

export const VALKEY_MAX_VALUE_BYTES = 512 * 1024 * 1024;

export function valkeyPackSemanticsOptions(
	options: ValkeyCatalogOptions,
): PackSemanticsOptions {
	const retention = valkeyRetentionSemantics({
		durabilityMode: options.durabilityMode,
		evictionPolicy: options.evictionPolicy,
	});
	return {
		definitionId: VALKEY_PACK_DEFINITION_ID,
		providerId: options.yardId,
		compilerRef: "hobo.compiler.pack-oci/v1",
		executorRef: "hobo.executor.pack-oci/v1",
		permissionProfileRef: "hobo.permission.pack-cache/v1",
		bootstrapStrategyRef: "hobo.bootstrap.pack-container/v1",
		trustEvidenceRef: "hobo.trust.pack-signature/v1",
		evidenceExpiresAtMs: options.evidenceExpiresAtMs,
		evidenceSignatureValid: options.evidenceSignatureValid,
		structuredCapabilities: {
			serverVersion: VALKEY_SERVER_VERSION,
			serverMajor: VALKEY_SERVER_MAJOR,
			redisCommandSemantics: true,
			ttl: true,
			atomicIncrement: true,
			sortedSets: true,
			restTransport: false,
			maxValueBytes: options.maxValueBytes ?? VALKEY_MAX_VALUE_BYTES,
			durability: retention.durability.mode,
			survivesRestart: retention.durability.survivesRestart,
			worstCaseLossMs: retention.durability.worstCaseLossMs ?? -1,
			eviction: retention.eviction.policy,
			keyLossPossible: retention.keyLossPossible,
			durableKeyspace: retention.behavesAsDurableKeyspace,
			tls: options.tls ?? false,
		},
		placementConstraints: [
			{ key: "storage.localVolume", operator: "equals", values: ["true"] },
		],
		requiresConnectivityProfiles: ["binding.redis-protocol/v1"],
		remediation: [
			{
				code: "PACK_PERSISTENCE_REQUIRED",
				message:
					"Bind a local volume of at least 256 MiB to valkey-data before deploying this pack; the pinned image declares no volume of its own.",
			},
			{
				code: "PACK_CONFIGURATION_INVALID",
				message:
					"durabilityMode, evictionPolicy, and maxmemoryBytes are required with no defaults. State the data-loss budget explicitly.",
			},
		],
		secretCustodyAvailable: true,
		supportsRotation: true,
		supportsRevocation: true,
	};
}

export function valkeyPackCandidate(
	manifest: VerifiedPackManifest,
	options: ValkeyCatalogOptions,
): SelectionCandidate {
	return toPackSelectionCandidate(
		manifest,
		valkeyPackSemanticsOptions(options),
	);
}

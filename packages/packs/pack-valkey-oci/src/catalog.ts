/**
 * Making the pack selectable.
 *
 * The capabilities advertised here are the ones `kv.redis-compatible/v1` declares
 * plus the retention facts, and they are computed from the deployment's chosen
 * durability and eviction settings rather than hard-coded. A pack deployed as a
 * lossy cache and a pack deployed with an fsync-per-write AOF are the same image
 * and *not* the same capability, so they must not present the same candidate.
 */
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
	/** The Yard that will run the container. Compute host, not a vendor. */
	readonly yardId: string;
	readonly evidenceExpiresAtMs: number;
	readonly evidenceSignatureValid: boolean;
	/** The durability the deployment is configured for. Not a default. */
	readonly durabilityMode: ValkeyDurabilityMode;
	/** The eviction policy the deployment is configured for. Not a default. */
	readonly evictionPolicy: ValkeyEvictionPolicy;
	readonly maxValueBytes?: number;
	readonly tls?: boolean;
};

/**
 * The maximum value size the protocol permits: 512 MiB for a string value.
 *
 * Advertised because `kv.key-value/v1` declares `maxValueBytes` as a feature and
 * an absent feature and a stated one behave differently in selection.
 */
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
			// There is no HTTP command transport in this image. A `true` here
			// would win selections for workloads that can only speak REST.
			restTransport: false,
			maxValueBytes: options.maxValueBytes ?? VALKEY_MAX_VALUE_BYTES,
			// The retention facts, so a requirement can gate on them.
			durability: retention.durability.mode,
			survivesRestart: retention.durability.survivesRestart,
			worstCaseLossMs: retention.durability.worstCaseLossMs ?? -1,
			eviction: retention.eviction.policy,
			keyLossPossible: retention.keyLossPossible,
			durableKeyspace: retention.behavesAsDurableKeyspace,
			// TLS is off unless the Yard terminates it.
			tls: options.tls ?? false,
		},
		placementConstraints: [
			// A single-writer volume cannot follow the container across hosts.
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

/**
 * The `binding.redis-protocol/v1` this pack produces.
 *
 * A workload that speaks the Redis protocol gets the same binding profile whether
 * a managed cache or this container is behind it — that is the portability claim.
 *
 * The binding carries a host, a port, and a `credentialRef`. It never carries a
 * `redis://user:pass@host` URL, because that URL *is* the credential;
 * `parseCapabilityBinding` rejects a host containing `:` or `@` for that reason.
 *
 * It also carries the retention facts in `metadataRefs`. A consumer that needs a
 * keyspace rather than a cache can read `keyLossPossible` off the binding instead
 * of asking an operator what the server was configured with.
 */
import {
	type CapabilityBinding,
	parseCapabilityBinding,
	parseSecretRef,
	type SecretRef,
} from "@hobo/bindings";
import { PackError, type VerifiedPackManifest } from "@hobo/pack-framework";

import { VALKEY_PORT, VALKEY_SERVER_VERSION } from "./image.js";
import { VALKEY_PACK_ID } from "./manifest.js";
import type { ValkeyRetentionSemantics } from "./semantics.js";

// public-contract: identifies Redis-protocol binding payloads.
export const VALKEY_BINDING_PROFILE = "binding.redis-protocol/v1" as const;

export type ValkeyBindingInput = {
	readonly bindingId: string;
	readonly resourceRef: string;
	/** In-cluster hostname the container is reachable at. Never a URL. */
	readonly host: string;
	readonly port?: number;
	/** Logical database index the consumer should SELECT. */
	readonly database?: number;
	/** Locator for the requirepass credential. */
	readonly credentialRef: SecretRef;
	/**
	 * Whether the client must use TLS. A required decision rather than an assumed
	 * `true`: an unenforced `true` is worse than an honest `false`.
	 */
	readonly tls: boolean;
	readonly certificateRef?: SecretRef;
	/** What the deployed server actually guarantees. */
	readonly retention: ValkeyRetentionSemantics;
	readonly producerEvidenceRef: string;
};

export function buildValkeyBinding(
	manifest: VerifiedPackManifest,
	input: ValkeyBindingInput,
): CapabilityBinding {
	if (manifest.packId !== VALKEY_PACK_ID) {
		throw new PackError(
			"PACK_MANIFEST_INVALID",
			`expected ${VALKEY_PACK_ID}, received ${manifest.packId}`,
		);
	}
	if (!manifest.producesBindingProfiles.includes(VALKEY_BINDING_PROFILE)) {
		throw new PackError(
			"PROVIDER_CONTRACT_CHANGED",
			`pack manifest no longer declares ${VALKEY_BINDING_PROFILE}`,
		);
	}
	if (input.tls && input.certificateRef === undefined) {
		throw new PackError(
			"PACK_CONFIGURATION_INVALID",
			"a TLS binding must reference the certificate the client should verify against",
		);
	}
	const database = input.database ?? 0;
	if (!Number.isInteger(database) || database < 0 || database > 255) {
		throw new PackError(
			"PACK_CONFIGURATION_INVALID",
			"binding database must be an integer between 0 and 255",
		);
	}

	return parseCapabilityBinding(
		{
			schemaVersion: "hobo.capability-binding/v1",
			id: input.bindingId,
			resourceRef: input.resourceRef,
			capabilityProfileRef: "kv.redis-compatible/v1",
			bindingProfileRef: VALKEY_BINDING_PROFILE,
			type: "redis",
			// No `provider`: there is no vendor product here, and naming one would
			// be the misrepresentation this pack exists to avoid.
			endpoints: [
				{
					protocol: "redis",
					role: "primary",
					addressRef: {
						host: input.host,
						port: input.port ?? VALKEY_PORT,
						tls: input.tls,
					},
				},
			],
			credentialRef: input.credentialRef,
			...(input.certificateRef !== undefined
				? { certificateRef: input.certificateRef }
				: undefined),
			metadataRefs: {
				database: String(database),
				serverVersion: VALKEY_SERVER_VERSION,
				packId: VALKEY_PACK_ID,
				imageDigest: manifest.selectedImage.digest,
				// The facts a consumer would otherwise have to guess.
				durabilityMode: input.retention.durability.mode,
				worstCaseLossMs:
					input.retention.durability.worstCaseLossMs === null
						? "entire-keyspace"
						: String(input.retention.durability.worstCaseLossMs),
				evictionPolicy: input.retention.eviction.policy,
				keyLossPossible: String(input.retention.keyLossPossible),
				// Stated so nobody reads pub/sub or list commands as a delivery
				// guarantee: this binding is a key/value surface only.
				deliveryGuarantees: "none",
			},
			// A container credential does not expire on its own, and claiming an
			// expiry nothing enforces would be a false promise.
			renewable: false,
			rotationSupported: true,
			revocationSupported: true,
			producerEvidenceRef: input.producerEvidenceRef,
		},
		parseSecretRef,
	);
}

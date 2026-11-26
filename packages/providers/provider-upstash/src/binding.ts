/**
 * Turning a temporary database into a portable binding.
 *
 * The product emits `binding.redis-rest/v1` only. It carries a hostname and a
 * secret locator — never the token, and never a `https://user:token@host`
 * convenience URL, which is the usual way a credential ends up in a plan.
 */
import {
	type CapabilityBinding,
	type CapabilityBindingInput,
	type NonSecretEndpointRef,
	type ParsedSecretRef,
	parseCapabilityBinding,
	parseSecretRef,
} from "@hobo/bindings";

import { UPSTASH_PROVIDER_ID } from "./definition.js";
import { UpstashProviderError } from "./errors.js";

// public-contract: binding profile id a consuming workload matches on.
export const UPSTASH_BINDING_PROFILE = "binding.redis-rest/v1" as const;

export type BuildBindingInput = {
	readonly bindingId: string;
	readonly resourceRef: string;
	readonly databaseId: string;
	/** Bare hostname. A hostname is not a credential; a token is. */
	readonly restEndpointHost: string;
	readonly tokenRef: ParsedSecretRef;
	/**
	 * The REST base URL, deposited separately.
	 *
	 * It is not secret, and it is deposited anyway: the Upstash SDK reads
	 * `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` as a pair, so
	 * projecting both through custody lets a connectivity implementation
	 * populate the pair without the driver assembling a URL that a careless
	 * edit could later have a token appended to.
	 */
	readonly urlRef?: ParsedSecretRef;
	/** Provider-reported expiry. Undefined once the database has been claimed. */
	readonly expiresAtMs?: number;
	readonly producerEvidenceRef: string;
};

export function restEndpointRef(host: string): NonSecretEndpointRef {
	return { host, port: 443, path: "/", tls: true };
}

export function buildUpstashCapabilityBinding(
	input: BuildBindingInput,
): CapabilityBinding {
	const metadataRefs = {
		databaseId: input.databaseId,
		restEndpointHost: input.restEndpointHost,
		...(input.urlRef !== undefined
			? { restUrlRef: input.urlRef.ref }
			: undefined),
	};

	const binding: CapabilityBindingInput = {
		schemaVersion: "hobo.capability-binding/v1",
		id: input.bindingId,
		resourceRef: input.resourceRef,
		capabilityProfileRef: "kv.redis-compatible/v1",
		bindingProfileRef: UPSTASH_BINDING_PROFILE,
		type: "redis",
		provider: UPSTASH_PROVIDER_ID,
		endpoints: [
			{
				protocol: "https",
				addressRef: restEndpointRef(input.restEndpointHost),
				role: "rest",
			},
		],
		credentialRef: input.tokenRef.ref,
		metadataRefs,
		...(input.expiresAtMs !== undefined
			? { expiresAtMs: input.expiresAtMs }
			: undefined),
		// The lease cannot be extended by an API call. Claiming is what
		// removes the expiry, and that is a human action, not a renewal.
		renewable: false,
		// True, but only through the console, and only by the owner after a
		// claim. The claim plan carries that as a blocking action so the flag
		// is not read as "the driver can do this".
		rotationSupported: true,
		// No revoke or delete endpoint exists on this surface at all.
		revocationSupported: false,
		producerEvidenceRef: input.producerEvidenceRef,
	};

	try {
		return parseCapabilityBinding(binding, parseSecretRef);
	} catch (cause) {
		throw new UpstashProviderError(
			"SECRET_REFERENCE_INVALID",
			"the temporary database did not produce a valid portable binding",
			{
				cause: cause instanceof Error ? cause : new Error(String(cause)),
				detail: { bindingId: input.bindingId },
			},
		);
	}
}

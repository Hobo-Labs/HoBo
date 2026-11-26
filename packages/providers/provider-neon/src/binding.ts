/**
 * Turning a claimable database into a portable binding.
 *
 * The product emits `binding.postgresql/v1` plus the Neon-specific
 * `binding.neon-serverless/v1`; which one a workload consumes is a
 * connectivity decision made elsewhere. Both carry the same locator, never the
 * credential.
 */
import {
	type CapabilityBinding,
	type CapabilityBindingInput,
	type NonSecretEndpointRef,
	type ParsedSecretRef,
	parseCapabilityBinding,
	parseSecretRef,
} from "@hobo/bindings";
import type { PostgresConnectionParts } from "./connection-string.js";
import { NeonProviderError } from "./errors.js";

export const NEON_BINDING_PROFILES = [
	"binding.postgresql/v1",
	"binding.neon-serverless/v1",
] as const;

export type NeonEndpoints = {
	readonly pooled: NonSecretEndpointRef;
	readonly direct: NonSecretEndpointRef;
};

export type BuildBindingInput = {
	readonly bindingId: string;
	readonly resourceRef: string;
	readonly endpoints: NeonEndpoints;
	readonly pooledCredentialRef: ParsedSecretRef;
	readonly directCredentialRef?: ParsedSecretRef;
	/** Provider-reported expiry. Undefined once the database has been claimed. */
	readonly expiresAtMs?: number;
	readonly producerEvidenceRef: string;
	readonly databaseName: string;
};

export function endpointsFor(
	parts: PostgresConnectionParts,
	directHost: string,
): NeonEndpoints {
	const pooled: NonSecretEndpointRef = {
		host: parts.host,
		port: parts.port,
		path: `/${parts.database}`,
		tls: parts.tls,
	};
	return {
		pooled,
		direct: { ...pooled, host: directHost },
	};
}

export function buildNeonCapabilityBinding(
	input: BuildBindingInput,
): CapabilityBinding {
	const metadataRefs = {
		databaseName: input.databaseName,
		pooledHost: input.endpoints.pooled.host,
		directHost: input.endpoints.direct.host,
		...(input.directCredentialRef !== undefined
			? { directCredentialRef: input.directCredentialRef.ref }
			: undefined),
	};

	const binding: CapabilityBindingInput = {
		schemaVersion: "hobo.capability-binding/v1",
		id: input.bindingId,
		resourceRef: input.resourceRef,
		capabilityProfileRef: "data.postgres/v1",
		bindingProfileRef: "binding.postgresql/v1",
		type: "postgresql",
		provider: "neon",
		endpoints: [
			{
				protocol: "postgresql",
				addressRef: input.endpoints.pooled,
				role: "pooled",
			},
			{
				protocol: "postgresql",
				addressRef: input.endpoints.direct,
				role: "primary",
			},
		],
		credentialRef: input.pooledCredentialRef.ref,
		metadataRefs,
		...(input.expiresAtMs !== undefined
			? { expiresAtMs: input.expiresAtMs }
			: undefined),
		renewable: false,
		rotationSupported: true,
		revocationSupported: true,
		producerEvidenceRef: input.producerEvidenceRef,
	};

	try {
		return parseCapabilityBinding(binding, parseSecretRef);
	} catch (cause) {
		throw new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the claimable database did not produce a valid portable binding",
			{ cause: cause instanceof Error ? cause : new Error(String(cause)) },
		);
	}
}

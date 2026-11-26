/**
 * Portable capability bindings.
 *
 * Provisioning a database does not decide how a Worker, a Vercel function, an
 * OCI container, a VM, a WASM component, or a local process consumes it. The
 * product emits a binding; a runtime-specific connectivity implementation
 * projects that binding into the workload. Those are separate decisions, and
 * keeping them separate is what makes Hyperdrive a connectivity implementation
 * rather than a database provider.
 *
 * Shape borrows from the Service Binding specification (servicebinding.io)
 * without its Kubernetes CRD model: abstract binding type plus optional
 * concrete provider, many bindings per workload, indirect secret locators.
 */
import type { ParsedSecretRef, SecretRef } from "./secret-ref.js";

export const BINDING_PROTOCOLS = [
	"postgresql",
	"mysql",
	"redis",
	"https",
	"wss",
	"s3",
	"amqp",
	"nats",
	"mqtt",
	"convex",
] as const;

export type BindingProtocol = (typeof BINDING_PROTOCOLS)[number];

/** First-party binding profile identifiers. Open for extension. */
export const STANDARD_BINDING_PROFILES = [
	"binding.postgresql/v1",
	"binding.neon-serverless/v1",
	"binding.redis-rest/v1",
	"binding.redis-protocol/v1",
	"binding.http/v1",
	"binding.websocket/v1",
	"binding.s3/v1",
	"binding.service-files/v1",
	"binding.wasi-config/v1",
	"binding.convex/v1",
] as const;

/** Non-secret address metadata. A hostname is not a credential. */
export type NonSecretEndpointRef = {
	readonly host: string;
	readonly port?: number;
	readonly path?: string;
	readonly tls: boolean;
};

export type BindingEndpoint = {
	readonly protocol: BindingProtocol;
	readonly addressRef: NonSecretEndpointRef;
	/** e.g. "primary", "pooled", "read-replica", "http-actions". */
	readonly role?: string;
};

export type CapabilityBindingInput = {
	readonly schemaVersion: "hobo.capability-binding/v1";
	readonly id: string;
	readonly resourceRef: string;
	readonly capabilityProfileRef: string;
	readonly bindingProfileRef: string;
	readonly type: string;
	/** Concrete product identity. Never required by the application. */
	readonly provider?: string;
	readonly endpoints: readonly BindingEndpoint[];
	readonly credentialRef?: string;
	readonly certificateRef?: string;
	readonly metadataRefs?: Readonly<Record<string, string>>;
	readonly expiresAtMs?: number;
	readonly renewable: boolean;
	readonly rotationSupported: boolean;
	readonly revocationSupported: boolean;
	readonly producerEvidenceRef: string;
};

export type CapabilityBinding = Omit<
	CapabilityBindingInput,
	"credentialRef" | "certificateRef"
> & {
	readonly credentialRef?: SecretRef;
	readonly certificateRef?: SecretRef;
};

export class CapabilityBindingError extends Error {
	readonly code: "NO_COMPATIBLE_BINDING" | "INVALID_CAPABILITY_BINDING";

	constructor(
		code: "NO_COMPATIBLE_BINDING" | "INVALID_CAPABILITY_BINDING",
		message: string,
	) {
		super(message);
		this.name = "CapabilityBindingError";
		this.code = code;
	}
}

/** Values that must never appear in an endpoint's non-secret metadata. */
const CREDENTIAL_IN_HOSTNAME = /[:@]/u;

/**
 * Parse-don't-validate boundary. Credential material may only enter through a
 * secret reference, so a binding is safe to place in a plan or a receipt.
 */
export function parseCapabilityBinding(
	input: CapabilityBindingInput,
	parseRef: (value: string) => ParsedSecretRef,
): CapabilityBinding {
	if (input.schemaVersion !== "hobo.capability-binding/v1") {
		throw new CapabilityBindingError(
			"INVALID_CAPABILITY_BINDING",
			`unsupported capability binding schemaVersion ${String(input.schemaVersion)}`,
		);
	}
	if (input.endpoints.length === 0) {
		throw new CapabilityBindingError(
			"INVALID_CAPABILITY_BINDING",
			`binding ${input.id} declares no endpoints`,
		);
	}
	for (const endpoint of input.endpoints) {
		if (CREDENTIAL_IN_HOSTNAME.test(endpoint.addressRef.host)) {
			throw new CapabilityBindingError(
				"INVALID_CAPABILITY_BINDING",
				`binding ${input.id} endpoint host must be a bare hostname; credentials belong in credentialRef`,
			);
		}
		if (
			endpoint.addressRef.port !== undefined &&
			(!Number.isInteger(endpoint.addressRef.port) ||
				endpoint.addressRef.port < 1 ||
				endpoint.addressRef.port > 65535)
		) {
			throw new CapabilityBindingError(
				"INVALID_CAPABILITY_BINDING",
				`binding ${input.id} endpoint port is out of range`,
			);
		}
	}

	const {
		credentialRef: rawCredentialRef,
		certificateRef: rawCertificateRef,
		...rest
	} = input;
	const credentialRef =
		rawCredentialRef !== undefined ? parseRef(rawCredentialRef).ref : undefined;
	const certificateRef =
		rawCertificateRef !== undefined
			? parseRef(rawCertificateRef).ref
			: undefined;

	// Endpoints are canonically ordered so two equivalent bindings hash alike.
	const endpoints = [...input.endpoints].sort(
		(a, b) =>
			a.protocol.localeCompare(b.protocol) ||
			(a.role ?? "").localeCompare(b.role ?? "") ||
			a.addressRef.host.localeCompare(b.addressRef.host),
	);

	// SAFETY: rest is the validated input with only secret locator fields removed.
	const parsed = {
		...rest,
		endpoints,
	} as Omit<CapabilityBinding, "credentialRef" | "certificateRef"> & {
		credentialRef?: SecretRef;
		certificateRef?: SecretRef;
	};
	if (credentialRef !== undefined) parsed.credentialRef = credentialRef;
	if (certificateRef !== undefined) parsed.certificateRef = certificateRef;
	return parsed;
}

/**
 * A runtime-specific projection of a binding into a workload.
 *
 * `cloudflare.postgres.hyperdrive/v1` and `vercel.postgres.environment-ref/v1`
 * consume the same `binding.postgresql/v1`; only the projection differs.
 */
export type ConnectivityImplementation = {
	readonly id: string;
	/** Binding profiles this implementation can consume. */
	readonly consumesBindingProfiles: readonly string[];
	/** Runtime models the consuming workload may use. */
	readonly runtimeModels: readonly string[];
	readonly providerId?: string;
	/** How the credential reaches the workload. Never a plaintext copy. */
	readonly projection:
		| "provider-binding"
		| "environment-secret-ref"
		| "service-binding-files"
		| "wasi-config"
		| "in-process";
	readonly requiresProviderResource?: string;
	readonly sourceRefs: readonly {
		readonly url: string;
		readonly checkedAt: string;
	}[];
};

export type ConnectivityRegistry = {
	list(): readonly ConnectivityImplementation[];
	/** Deterministic: candidates ordered by id, never by registration order. */
	resolve(query: {
		readonly bindingProfileRef: string;
		readonly runtimeModel: string;
		readonly providerId?: string;
	}): readonly ConnectivityImplementation[];
};

export function createConnectivityRegistry(
	implementations: readonly ConnectivityImplementation[],
): ConnectivityRegistry {
	const seen = new Set<string>();
	for (const implementation of implementations) {
		if (seen.has(implementation.id)) {
			throw new CapabilityBindingError(
				"INVALID_CAPABILITY_BINDING",
				`duplicate connectivity implementation ${implementation.id}`,
			);
		}
		seen.add(implementation.id);
	}
	const ordered = [...implementations].sort((a, b) => a.id.localeCompare(b.id));

	return {
		list() {
			return ordered;
		},
		resolve(query) {
			return ordered.filter((implementation) => {
				if (
					!implementation.consumesBindingProfiles.includes(
						query.bindingProfileRef,
					)
				) {
					return false;
				}
				if (!implementation.runtimeModels.includes(query.runtimeModel))
					return false;
				// A provider-scoped implementation only applies inside its own Yard.
				if (
					implementation.providerId !== undefined &&
					query.providerId !== undefined &&
					implementation.providerId !== query.providerId
				) {
					return false;
				}
				return true;
			});
		},
	};
}

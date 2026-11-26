import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

export type { JsonValue } from "./json.js";

export type FluxSourceKind = "oci" | "git";
export type FluxTier = "community-free" | "paid-multi-instance";
export type FluxEnvironment = "preview" | "production";
export type FluxPrimitive =
	| "web"
	| "api"
	| "service"
	| "actor"
	| "data"
	| "kv"
	| "queue"
	| "bucket";

export class FluxProviderError extends Error {
	readonly code:
		| "PARSE"
		| "DIGEST_REQUIRED"
		| "WEBHOOK_UNSIGNED"
		| "STATUS_LOGS_PUBLIC"
		| "SECRET_MATERIAL"
		| "PRIMITIVE_UNSUPPORTED"
		| "COMMUNITY_PRODUCTION"
		| "RESIDENCY_UNMAPPED"
		| "CONTROL_PLANE_ON_COMMUNITY";

	constructor(code: FluxProviderError["code"], message: string) {
		super(message);
		this.name = "FluxProviderError";
		this.code = code;
	}
}

// domain-view: parse-don't-validate parsed/derived type; wire form is FluxDeploySpec in data-models/provider_flux.proto.
export interface FluxDeploySpec {
	readonly source: FluxSourceKind;
	readonly imageDigest?: string;
	readonly gitRepository?: string;
	readonly webhookSecretRef?: string;
	readonly apiKeySecretRef?: string;
	readonly webhookSigned: boolean;
	readonly statusLogsAuthenticated: boolean;
	readonly tier: FluxTier;
	readonly environment: FluxEnvironment;
	readonly primitives: readonly FluxPrimitive[];
	readonly hostsRivetControlPlane?: boolean;
	readonly residencyRegion?: string;
}

function isSource(value: string): value is FluxSourceKind {
	switch (value) {
		case "oci":
		case "git":
			return true;
		default:
			return false;
	}
}

function isTier(value: string): value is FluxTier {
	switch (value) {
		case "community-free":
		case "paid-multi-instance":
			return true;
		default:
			return false;
	}
}

function isEnvironment(value: string): value is FluxEnvironment {
	switch (value) {
		case "preview":
		case "production":
			return true;
		default:
			return false;
	}
}

function isPrimitive(value: string): value is FluxPrimitive {
	switch (value) {
		case "web":
		case "api":
		case "service":
		case "actor":
		case "data":
		case "kv":
		case "queue":
		case "bucket":
			return true;
		default:
			return false;
	}
}

function isSupportedPrimitive(value: FluxPrimitive): boolean {
	switch (value) {
		case "web":
		case "api":
		case "service":
			return true;
		default:
			return false;
	}
}

function isLocator(value: string, path: string): string {
	if (/token|password|sk-|AKIA/iu.test(value) || value.includes("://")) {
		throw new FluxProviderError(
			"SECRET_MATERIAL",
			`${path} must be a secretRef locator`,
		);
	}
	return value;
}

export function parseFluxDeploySpec(input: JsonValue): FluxDeploySpec {
	if (!isJsonObject(input)) {
		throw new FluxProviderError("PARSE", "flux deploy spec must be an object");
	}
	const source = input.source;
	if (!isJsonString(source) || !isSource(source)) {
		throw new FluxProviderError("PARSE", "source must be oci|git");
	}
	const tier = input.tier;
	if (!isJsonString(tier) || !isTier(tier)) {
		throw new FluxProviderError(
			"PARSE",
			"tier must be community-free|paid-multi-instance",
		);
	}
	const environment = input.environment;
	if (!isJsonString(environment) || !isEnvironment(environment)) {
		throw new FluxProviderError(
			"PARSE",
			"environment must be preview|production",
		);
	}
	const primitivesRaw = input.primitives;
	if (!isJsonArray(primitivesRaw) || primitivesRaw.length === 0) {
		throw new FluxProviderError(
			"PARSE",
			"primitives must be a non-empty array",
		);
	}
	const primitives: FluxPrimitive[] = [];
	for (const item of primitivesRaw) {
		if (!isJsonString(item) || !isPrimitive(item)) {
			throw new FluxProviderError("PARSE", "primitive must be a string");
		}
		primitives.push(item);
	}
	for (const primitive of primitives) {
		if (!isSupportedPrimitive(primitive)) {
			throw new FluxProviderError(
				"PRIMITIVE_UNSUPPORTED",
				`Flux does not realize ${primitive}; use an actor/data/kv/queue/bucket provider or an explicit recipe`,
			);
		}
	}
	if (input.hostsRivetControlPlane === true && tier === "community-free") {
		throw new FluxProviderError(
			"CONTROL_PLANE_ON_COMMUNITY",
			"Rivet control plane must not run on community Flux nodes",
		);
	}
	if (input.residencyRegion === "") {
		throw new FluxProviderError(
			"RESIDENCY_UNMAPPED",
			"unmapped residency region fails closed (ADR-0146)",
		);
	}
	const spec: FluxDeploySpec = {
		source,
		webhookSigned: input.webhookSigned === true,
		statusLogsAuthenticated: input.statusLogsAuthenticated === true,
		tier,
		environment,
		primitives,
		...(isJsonString(input.imageDigest)
			? { imageDigest: input.imageDigest }
			: undefined),
		...(isJsonString(input.gitRepository)
			? { gitRepository: input.gitRepository }
			: undefined),
		...(isJsonString(input.webhookSecretRef)
			? {
					webhookSecretRef: isLocator(
						input.webhookSecretRef,
						"webhookSecretRef",
					),
				}
			: undefined),
		...(isJsonString(input.apiKeySecretRef)
			? {
					apiKeySecretRef: isLocator(input.apiKeySecretRef, "apiKeySecretRef"),
				}
			: undefined),
		...(input.hostsRivetControlPlane === true
			? { hostsRivetControlPlane: true }
			: undefined),
		...(isJsonString(input.residencyRegion)
			? { residencyRegion: input.residencyRegion }
			: undefined),
	};
	return Object.freeze(spec);
}

export interface FluxApplyReceipt {
	readonly applied: boolean;
	readonly source: FluxSourceKind;
	readonly orbitMode: boolean;
}

export function applyFluxDeploy(spec: FluxDeploySpec): FluxApplyReceipt {
	if (spec.environment === "production") {
		if (spec.source !== "oci" || !spec.imageDigest?.startsWith("sha256:")) {
			throw new FluxProviderError(
				"DIGEST_REQUIRED",
				"production Flux apply requires source=oci and an image digest",
			);
		}
		if (!spec.webhookSigned) {
			throw new FluxProviderError(
				"WEBHOOK_UNSIGNED",
				"production Flux apply requires a signed webhook",
			);
		}
		if (!spec.statusLogsAuthenticated) {
			throw new FluxProviderError(
				"STATUS_LOGS_PUBLIC",
				"production Flux apply requires API_KEY so /status and /health are not public",
			);
		}
		if (spec.tier === "community-free") {
			throw new FluxProviderError(
				"COMMUNITY_PRODUCTION",
				"production-like Flux workloads require paid multi-instance",
			);
		}
	}
	return {
		applied: true,
		source: spec.source,
		orbitMode: spec.source === "git",
	};
}

export const FLUX_RIVET_RUNNER_RECIPE = {
	id: "rivet-runners-on-flux",
	controlPlane: "trusted-yard",
	runners: "flux-outbound-only",
} as const;

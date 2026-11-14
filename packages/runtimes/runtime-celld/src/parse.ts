import {
	actorCompoundKey,
	type LogicalActorIdentity,
	parseLogicalActorIdentity,
} from "@hobo/core";
import { OVERLAY_PROVIDERS, type OverlayProvider } from "@hobo/fleet";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

/** The overlay providers celld accepts: exactly `OVERLAY_PROVIDERS` of `@hobo/fleet`, so there is one list. */
export type CelldOverlay = OverlayProvider;
export const CELLD_OVERLAYS: readonly CelldOverlay[] = OVERLAY_PROVIDERS;

function isCelldOverlay(value: string): value is CelldOverlay {
	return CELLD_OVERLAYS.some((provider) => provider === value);
}

export class CelldConfigError extends Error {
	readonly code:
		| "PARSE"
		| "OPERATOR_PORT_PUBLIC"
		| "OVERLAY_REQUIRED"
		| "HOSTILE_ISOLATION"
		| "SECRET_MATERIAL"
		| "WASM_COMPONENT_MODEL"
		| "BUCKET_SCHEME";

	constructor(code: CelldConfigError["code"], message: string) {
		super(message);
		this.name = "CelldConfigError";
		this.code = code;
	}
}

// domain-view: parse-don't-validate parsed/derived type; wire form is CelldRuntimeConfig in data-models/runtime_celld.proto.
export interface CelldRuntimeConfig {
	readonly campId: string;
	readonly tenantId: string;
	readonly bucketUri: string;
	readonly bucketSecretRef: string;
	readonly advertise: string;
	readonly internalListen: string;
	readonly overlay: CelldOverlay;
	readonly operatorPortPublic: false;
	readonly isolation: "trusted";
	readonly svidBindingRef: string;
}

function requiredString(record: JsonObject, key: string): string {
	const value = record[key];
	if (!isJsonString(value) || value.length === 0) {
		throw new CelldConfigError("PARSE", `${key} is required`);
	}
	return value;
}

export function parseCelldRuntimeConfig(input: JsonValue): CelldRuntimeConfig {
	if (!isJsonObject(input) || input === null) {
		throw new CelldConfigError("PARSE", "celld config must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const record = input as JsonObject;
	if (record.operatorPortPublic === true) {
		throw new CelldConfigError(
			"OPERATOR_PORT_PUBLIC",
			"celld operator/peer port must stay on a private overlay",
		);
	}
	if (record.isolation === "hostile") {
		throw new CelldConfigError(
			"HOSTILE_ISOLATION",
			"celld is unsafe for hostile multi-tenancy; one fleet per trust boundary",
		);
	}
	if (record.componentModelWasm === true) {
		throw new CelldConfigError(
			"WASM_COMPONENT_MODEL",
			"celld WASM is a Worker-imported module, not the HoBo Component Model",
		);
	}
	const overlayRaw = record.overlay;
	if (!isJsonString(overlayRaw) || !isCelldOverlay(overlayRaw)) {
		throw new CelldConfigError(
			"OVERLAY_REQUIRED",
			`overlay must be ${CELLD_OVERLAYS.join("|")}`,
		);
	}
	const overlay: CelldOverlay = overlayRaw;
	const bucketUri = requiredString(record, "bucketUri");
	if (!/^(s3|gs|r2):\/\//u.test(bucketUri)) {
		throw new CelldConfigError(
			"BUCKET_SCHEME",
			"bucketUri must be s3://, gs://, or r2:// with proven CAS; filesystem and unproven NATS Object Store are rejected",
		);
	}
	const bucketSecretRef = requiredString(record, "bucketSecretRef");
	const svid = requiredString(record, "svidBindingRef");
	for (const [path, value] of [
		["bucketSecretRef", bucketSecretRef],
		["svidBindingRef", svid],
	] as const) {
		if (
			/token|password|sk-|AKIA/iu.test(value) ||
			/^https?:\/\//iu.test(value) ||
			value.includes("@")
		) {
			throw new CelldConfigError(
				"SECRET_MATERIAL",
				`${path} must be a locator, not secret material or a URL`,
			);
		}
	}
	return Object.freeze({
		campId: requiredString(record, "campId"),
		tenantId: requiredString(record, "tenantId"),
		bucketUri,
		bucketSecretRef,
		advertise: requiredString(record, "advertise"),
		internalListen: requiredString(record, "internalListen"),
		overlay,
		operatorPortPublic: false,
		isolation: "trusted",
		svidBindingRef: svid,
	});
}

export function celldCellName<T>(identity: T): string {
	const parsed: LogicalActorIdentity = parseLogicalActorIdentity(
		cloneAsJson(identity),
	);
	return actorCompoundKey(parsed).join("/");
}

export interface CelldCasProbe {
	conditionalWrite: boolean;
	readAfterWrite: boolean;
}

export function evaluateCelldBucketCas(probe: CelldCasProbe): boolean {
	return probe.conditionalWrite && probe.readAfterWrite;
}

export const CELLD_ON_FLUX = {
	status: "unsupported" as const,
	missingProofs: [
		"stable-per-instance-identity",
		"peer-addressable-internal-endpoints",
		"private-or-encrypted-overlay",
		"operator-port-unpublished",
		"narrow-bucket-credentials",
		"reserve-capacity-for-failover",
		"graceful-drain-and-rollout",
		"predictable-object-store-latency",
		"safe-version-coordination",
		"websocket-reconnect-across-replacement",
	],
};

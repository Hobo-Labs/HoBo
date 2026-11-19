
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, isJsonString } from "./json.js";

import { stationRoot } from "./station-client.js";

// public-contract: wire schema of a declared Station capability.
export const STATION_CAPABILITY_SCHEMA = "hobo.station-capability/v1" as const;
// public-contract: wire schema of a matched Station capability manifest.
export const STATION_CAPABILITY_MANIFEST_SCHEMA =
	"hobo.station-capability-manifest/v1" as const;

export type StationCapabilityKind =
	| "runtime"
	| "vcs"
	| "isolation-backend"
	| "model-server"
	| "toolchain"
	| "harness"
	| "sidecar"
	| "pam"
	| "replay";

export type StationCapabilityProvenance = "default" | "discovered" | "declared";

export type StationCapability = Readonly<{
	schema: typeof STATION_CAPABILITY_SCHEMA;
	id: string;
	kind: StationCapabilityKind;
	slug: string;
	title: string;
	provenance: StationCapabilityProvenance;
	required: boolean;
	remediation?: string;
	metadata: Readonly<Record<string, string>>;
}>;

export type StationCapabilitySpec = Readonly<{
	kind: StationCapabilityKind;
	slug: string;
	title: string;
	provenance?: StationCapabilityProvenance;
	required?: boolean;
	remediation?: string;
	metadata?: Readonly<Record<string, string>>;
}>;

const CAPABILITY_KINDS: readonly StationCapabilityKind[] = [
	"runtime",
	"vcs",
	"isolation-backend",
	"model-server",
	"toolchain",
	"harness",
	"sidecar",
	"pam",
	"replay",
];

const SLUG_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

function deepFreeze<T>(value: T): T {
	if (value === null || value === undefined || Object.isFrozen(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		for (const child of value) {
			deepFreeze(child);
		}
		return Object.freeze(value);
	}
	if (!isJsonObject(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

export function stationCapability(
	spec: StationCapabilitySpec,
): StationCapability {
	if (!spec || !isJsonObject(spec)) {
		throw new TypeError("station capability spec must be an object");
	}
	if (!CAPABILITY_KINDS.includes(spec.kind)) {
		throw new TypeError(
			`station capability kind must be one of ${CAPABILITY_KINDS.join(" | ")}`,
		);
	}
	if (!isJsonString(spec.slug) || !SLUG_PATTERN.test(spec.slug)) {
		throw new TypeError(
			"station capability slug must match [a-z0-9][a-z0-9.-]*",
		);
	}
	if (!isJsonString(spec.title) || spec.title.length === 0) {
		throw new TypeError("station capability title must be a non-empty string");
	}
	const provenance = spec.provenance ?? "discovered";
	return deepFreeze({
		schema: STATION_CAPABILITY_SCHEMA,
		id: `capability:${spec.kind}:${spec.slug}`,
		kind: spec.kind,
		slug: spec.slug,
		title: spec.title,
		provenance,
		required: spec.required === true,
		...(spec.remediation !== undefined
			? { remediation: spec.remediation }
			: undefined),
		metadata: { ...spec.metadata },
	});
}

export type StationCapabilityObservation = Readonly<{
	capabilityId: string;
	present: boolean;
	evidence: readonly string[];
	detail?: string;
}>;

export type StationCapabilityStatus = "present" | "missing";

export type MatchedStationCapability = Readonly<{
	capability: StationCapability;
	status: StationCapabilityStatus;
	evidence: readonly string[];
	detail?: string;
}>;

export type StationCapabilityManifest = Readonly<{
	schema: typeof STATION_CAPABILITY_MANIFEST_SCHEMA;
	stationId: string;
	ok: boolean;
	capabilities: readonly MatchedStationCapability[];
	missingRequired: readonly string[];
	remediation: readonly string[];
	generatedAt: string;
}>;

export function matchStationCapabilities(input: {
	readonly stationId: string;
	readonly declared: readonly StationCapability[];
	readonly observations: readonly StationCapabilityObservation[];
	readonly now?: () => string;
}): StationCapabilityManifest {
	if (!isJsonString(input.stationId) || input.stationId.length === 0) {
		throw new TypeError("stationId must be a non-empty string");
	}
	const byId = new Map<string, StationCapabilityObservation>();
	for (const observation of input.observations) {
		byId.set(observation.capabilityId, observation);
	}
	const matched: MatchedStationCapability[] = [];
	const missingRequired: string[] = [];
	const remediation: string[] = [];
	for (const capability of input.declared) {
		const observation = byId.get(capability.id);
		const present = observation
			? observation.present
			: capability.provenance === "default";
		const evidence = observation
			? [...observation.evidence]
			: capability.provenance === "default"
				? ["default-supplied"]
				: [];
		matched.push(
			deepFreeze({
				capability,
				status: present ? ("present" as const) : ("missing" as const),
				evidence,
				...(observation?.detail !== undefined
					? { detail: observation.detail }
					: undefined),
			}),
		);
		if (!present) {
			if (capability.required) missingRequired.push(capability.id);
			if (capability.remediation) remediation.push(capability.remediation);
		}
	}
	return deepFreeze({
		schema: STATION_CAPABILITY_MANIFEST_SCHEMA,
		stationId: input.stationId,
		ok: missingRequired.length === 0,
		capabilities: matched,
		missingRequired,
		remediation,
		generatedAt: (input.now ?? (() => new Date().toISOString()))(),
	});
}

export function stationCapabilitiesPath(
	hoboHome: string,
	stationId: string,
): string {
	return join(stationRoot(hoboHome, stationId), "capabilities.json");
}

export function persistStationCapabilityManifest(
	hoboHome: string,
	stationId: string,
	manifest: StationCapabilityManifest,
): string {
	const path = stationCapabilitiesPath(hoboHome, stationId);
	mkdirSync(stationRoot(hoboHome, stationId), { recursive: true });
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	return path;
}

export function loadStationCapabilityManifest(
	hoboHome: string,
	stationId: string,
): StationCapabilityManifest | null {
	const path = stationCapabilitiesPath(hoboHome, stationId);
	if (!existsSync(path)) return null;
	const raw = JSON.parse(
		readFileSync(path, "utf8"),
	) as StationCapabilityManifest;
	if (raw.schema !== STATION_CAPABILITY_MANIFEST_SCHEMA) return null;
	return raw;
}

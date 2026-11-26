/**
 * Station capabilities: the formal type behind the "PAM is a Station
 * capability" / "Session Replay is a Station capability" / "Station
 * sidecars" prose (ADR-0133 / ADR-0137 / ADR-0155). A capability is a
 * declared, schema-versioned facility a Station offers its occupants;
 * a manifest is the audited match of a declared set against evidence
 * observed on the occupying host. Matching is fail-closed: a declared
 * capability with no observation is missing, never assumed present.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, isJsonString } from "./json.js";

import { stationRoot } from "./station-client.js";

// public-contract: wire schema of a declared Station capability.
export const STATION_CAPABILITY_SCHEMA = "hobo.station-capability/v1" as const;
// public-contract: wire schema of a matched Station capability manifest.
export const STATION_CAPABILITY_MANIFEST_SCHEMA =
	"hobo.station-capability-manifest/v1" as const;

/** Closed capability vocabulary — one row per facility family a Station can offer. */
export type StationCapabilityKind =
	| "runtime" // language/host runtime (node, wasm host)
	| "vcs" // version control the isolation backends require
	| "isolation-backend" // rift / worktree (ADR-0139 platform matrix)
	| "model-server" // local SLM endpoint (the $0 path)
	| "toolchain" // hermetic shell toolchain (devenv/nix)
	| "harness" // registered coding harnesses (agents init)
	| "sidecar" // Station sidecars (dashboard / Evidence / evals)
	| "pam" // Privileged Access Gateway (ADR-0133)
	| "replay"; // Session Replay (ADR-0137)

/**
 * Where the capability claim comes from:
 * - "default": default-supplied by the platform itself (present unless an
 *   observation explicitly reports it absent);
 * - "discovered": claimed only from host evidence (fail-closed without it);
 * - "declared": operator-declared (still requires evidence to match).
 */
export type StationCapabilityProvenance = "default" | "discovered" | "declared";

export type StationCapability = Readonly<{
	schema: typeof STATION_CAPABILITY_SCHEMA;
	/** `capability:<kind>:<slug>` — stable id evidence and manifests key on. */
	id: string;
	kind: StationCapabilityKind;
	slug: string;
	title: string;
	provenance: StationCapabilityProvenance;
	/** Required capabilities gate explicit occupancy init; optional ones degrade. */
	required: boolean;
	/** How to obtain the capability when it is missing. */
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

/**
 * Declare one Station capability. Parse-don't-validate: a bad spec throws
 * here, never later inside matching or persistence.
 */
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

/** One piece of host evidence about a declared capability. */
export type StationCapabilityObservation = Readonly<{
	capabilityId: string;
	present: boolean;
	/** Auditable evidence rows, e.g. "bin:/usr/bin/git", "http:127.0.0.1:11434". */
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
	/** True when every required capability matched. */
	ok: boolean;
	capabilities: readonly MatchedStationCapability[];
	missingRequired: readonly string[];
	remediation: readonly string[];
	generatedAt: string;
}>;

/**
 * Match a declared capability set against host observations.
 * Fail-closed: "discovered"/"declared" capabilities with no observation are
 * missing. "default" provenance is present-by-construction unless an
 * observation explicitly reports absence.
 */
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

/** Manifest location beside the Station's event log (discovery parallel to sidecars.json). */
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
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = JSON.parse(
		readFileSync(path, "utf8"),
	) as StationCapabilityManifest;
	if (raw.schema !== STATION_CAPABILITY_MANIFEST_SCHEMA) return null;
	return raw;
}

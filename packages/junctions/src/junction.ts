import type { Yard } from "@hobo/yards";

import { deepFreeze } from "./freeze.js";
import { isJsonString } from "./json.js";
import {
	CONNECTIVITY_TIER_LEVELS,
	type ConnectivityTierName,
	JUNCTION_CONTRACT_VERSION,
	type JunctionDefinition,
	type JunctionMemberManifest,
	JunctionParseError,
} from "./types.js";

/**
 * Optional per-member manifest declarations. Everything the tier selection
 * uses is declared here or defaulted conservatively; nothing is probed live.
 */
export interface JunctionMemberManifestInput {
	readonly region?: string;
	readonly capabilities?: readonly ConnectivityTierName[];
	readonly residency?: readonly string[];
}

export interface JunctionConfig {
	readonly yards: readonly Yard[];
	readonly manifests?: Readonly<Record<string, JunctionMemberManifestInput>>;
}

const JUNCTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// The junction never assumes a tier a member did not declare. Members that
// declare nothing get every tier that needs no dedicated circuit;
// private-interconnect always requires an explicit declaration.
const DEFAULT_CAPABILITIES: readonly ConnectivityTierName[] = [
	"private-network",
	"cross-region",
	"overlay-mesh",
	"public-mtls",
];

/**
 * Parse member Yards (and optional manifest declarations) into a deep-frozen
 * JunctionDefinition — parse, don't validate. Downstream derivations accept
 * only the parsed value, never raw config.
 */
export function junction(
	name: string,
	config: JunctionConfig,
): JunctionDefinition {
	if (!isJsonString(name) || !JUNCTION_NAME_PATTERN.test(name)) {
		throw new JunctionParseError(
			"junction.name.invalid",
			"junction name must be a non-empty lowercase DNS-safe string (a-z, 0-9, -)",
		);
	}

	const yards = config?.yards;
	if (!Array.isArray(yards) || yards.length === 0) {
		throw new JunctionParseError(
			"junction.members.empty",
			"junction requires member Yards",
		);
	}
	if (yards.length < 2) {
		throw new JunctionParseError(
			"junction.members.insufficient",
			"junction requires at least two member Yards to federate",
		);
	}

	const seen = new Set<string>();
	for (const entry of yards) {
		if (entry?.kind !== "yard") {
			throw new JunctionParseError(
				"junction.member.invalid",
				"junction yards must be parsed Yard objects from @hobo/yards",
			);
		}
		if (seen.has(entry.name)) {
			throw new JunctionParseError(
				"junction.member.duplicate",
				`member Yard ${entry.name} appears more than once`,
			);
		}
		seen.add(entry.name);
	}

	const manifests = config.manifests ?? {};
	for (const yardName of Object.keys(manifests)) {
		if (!seen.has(yardName)) {
			throw new JunctionParseError(
				"junction.manifest.unknown-yard",
				`manifest declared for ${yardName}, which is not a member Yard`,
			);
		}
	}

	const members = [...yards]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((yardEntry) => parseMember(yardEntry, manifests[yardEntry.name]));

	return deepFreeze({
		kind: "junction",
		contract: JUNCTION_CONTRACT_VERSION,
		name,
		yards,
		members,
	});
}

function parseMember(
	yardEntry: Yard,
	input: JunctionMemberManifestInput | undefined,
): JunctionMemberManifest {
	const region = input?.region ?? null;
	if (region !== null && (!isJsonString(region) || region.length === 0)) {
		throw new JunctionParseError(
			"junction.manifest.invalid",
			`manifest region for ${yardEntry.name} must be a non-empty string`,
		);
	}

	const capabilities = input?.capabilities ?? DEFAULT_CAPABILITIES;
	if (!Array.isArray(capabilities) || capabilities.length === 0) {
		throw new JunctionParseError(
			"junction.manifest.invalid",
			`manifest capabilities for ${yardEntry.name} must be a non-empty array`,
		);
	}
	for (const capability of capabilities) {
		if (!(capability in CONNECTIVITY_TIER_LEVELS)) {
			throw new JunctionParseError(
				"junction.manifest.invalid",
				`manifest capability ${String(capability)} for ${yardEntry.name} is not a connectivity tier`,
			);
		}
	}

	const residency = input?.residency ?? [];
	if (
		!Array.isArray(residency) ||
		residency.some((entry) => !isJsonString(entry) || entry.length === 0)
	) {
		throw new JunctionParseError(
			"junction.manifest.invalid",
			`manifest residency for ${yardEntry.name} must be an array of non-empty strings`,
		);
	}

	return {
		yardName: yardEntry.name,
		providerId: yardEntry.providerId,
		region,
		capabilities,
		residency,
	};
}

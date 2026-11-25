/**
 * Experience-proof surface for the control-plane Yard game UI.
 * Pins zone contract + sheet confirm path without live cloud deps.
 */

export const CONTROL_YARD_PROOF = "control-yard" as const;
export const CONTROL_YARD_ADR = "ADR-0135" as const;

export const REQUIRED_ZONES = [
	"platformRest",
	"bootstrapDesk",
	"activeRailTrack",
	"connectionBay",
	"policyBoard",
	"costBooth",
	"errorBunker",
] as const;

export type ControlYardZone = (typeof REQUIRED_ZONES)[number];

export type ControlYardAcceptance = Readonly<{
	proof: typeof CONTROL_YARD_PROOF;
	adr: typeof CONTROL_YARD_ADR;
	zones: readonly ControlYardZone[];
	packages: readonly string[];
	artBible: string;
	managementPath: string;
	noSecondLifecycle: true;
	boWestIsNotMirror: true;
}>;

export function controlYardAcceptance(): ControlYardAcceptance {
	return Object.freeze({
		proof: CONTROL_YARD_PROOF,
		adr: CONTROL_YARD_ADR,
		zones: REQUIRED_ZONES,
		packages: Object.freeze([
			"@hobo/management",
			"@hobo/control-api",
			"@hobo/control-yard",
		]),
		artBible: "site/public/parallax/README.md",
		managementPath: "CLI + MCP + control-api → @hobo/management",
		noSecondLifecycle: true,
		boWestIsNotMirror: true,
	});
}

export function assertYardZones(
	zones: readonly string[],
): { ok: true } | { ok: false; missing: string[] } {
	const missing = REQUIRED_ZONES.filter((z) => !zones.includes(z));
	if (missing.length > 0) return { ok: false, missing: [...missing] };
	return { ok: true };
}

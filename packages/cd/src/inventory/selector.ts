// Selector parsing and matching over declared Camp topology (D20). Selectors
// read only declared facts (labels, env type, declared Yard regions, ids);
// observed claims never take part (I19).
import { type JurisdictionId, jurisdictionsForRegion } from "@hobo/core";
import type { ReasonRecord, SelectorRecord } from "../_generated/cd_pb.js";
import type { CampTopology } from "../ports.js";
import { reason } from "./support.js";

/** A selector whose fields were checked at a parse boundary. */
export type ParsedSelector = SelectorRecord & { readonly __brand: "cd.ParsedSelector" };

const LABEL_KEY = /^[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const SHORT_TEXT = 256;

export function isEmptySelector(selector: SelectorRecord | undefined): boolean {
	if (selector === undefined) return true;
	return (
		Object.keys(selector.labels).length === 0 &&
		selector.envTypes.length === 0 &&
		selector.jurisdictions.length === 0 &&
		selector.campIds.length === 0 &&
		selector.bindles.length === 0
	);
}

/**
 * Parse a selector. `bindles` cannot be evaluated against Camp topology, so a
 * selector naming them is refused rather than silently matching nothing.
 */
export function parseSelector(
	selector: SelectorRecord | undefined,
	path: string,
): Readonly<{ ok: true; value: ParsedSelector | undefined }> | Readonly<{ ok: false; reasons: readonly ReasonRecord[] }> {
	if (selector === undefined) return { ok: true, value: undefined };
	const reasons: ReasonRecord[] = [];
	if (selector.bindles.length > 0) {
		reasons.push(
			reason(
				"selector-unsupported",
				`${path}.bindles cannot select Camps: Camp topology carries no Bindle`,
				"select Camps by labels, env types, jurisdictions or Camp ids",
				`${path}.bindles`,
			),
		);
	}
	for (const [key, value] of Object.entries(selector.labels)) {
		if (!LABEL_KEY.test(key) || value.length > SHORT_TEXT) {
			reasons.push(
				reason(
					"selector-invalid",
					`${path}.labels has an invalid entry "${key}"`,
					"use label keys of letters, digits, '.', '_', '/', '-' (at most 128) and values of at most 256 characters",
					`${path}.labels.${key}`,
				),
			);
		}
	}
	for (const [field, values] of [
		["envTypes", selector.envTypes],
		["jurisdictions", selector.jurisdictions],
		["campIds", selector.campIds],
	] as const) {
		if (values.some((value) => value === "" || value.length > SHORT_TEXT)) {
			reasons.push(
				reason(
					"selector-invalid",
					`${path}.${field} has an empty or oversized entry`,
					"remove empty entries; keep each entry at most 256 characters",
					`${path}.${field}`,
				),
			);
		}
	}
	if (reasons.length > 0) return { ok: false, reasons };
	// SAFETY: every field was checked above; the brand records that.
	return { ok: true, value: selector as ParsedSelector };
}

/** Jurisdictions of every declared region, sorted and unique. */
export function campJurisdictions(topology: CampTopology): readonly JurisdictionId[] {
	const all = new Set<JurisdictionId>();
	for (const region of topology.regions) {
		for (const jurisdiction of jurisdictionsForRegion(region)) all.add(jurisdiction);
	}
	return [...all].sort();
}

/**
 * True when declared topology satisfies every non-empty selector field (AND
 * across fields). `jurisdictions` needs every declared region to sit in a
 * listed jurisdiction; a Camp with no declared region never matches it.
 * An empty selector matches every Camp.
 */
export function matchesSelector(selector: SelectorRecord | undefined, topology: CampTopology): boolean {
	if (selector === undefined) return true;
	if (selector.bindles.length > 0) return false;
	for (const [key, value] of Object.entries(selector.labels)) {
		if (topology.labels[key] !== value) return false;
	}
	if (selector.envTypes.length > 0 && !selector.envTypes.includes(topology.envType)) return false;
	if (selector.campIds.length > 0 && !selector.campIds.includes(topology.campId)) return false;
	if (selector.jurisdictions.length > 0) {
		if (topology.regions.length === 0) return false;
		for (const region of topology.regions) {
			const inside = jurisdictionsForRegion(region);
			if (!inside.some((jurisdiction) => selector.jurisdictions.includes(jurisdiction))) return false;
		}
	}
	return true;
}

import { parseDataClassification, parseJurisdictionId } from "@hobo/core";
import { isJsonString, type JsonValue } from "../json.js";
import type { YardLayout } from "./types.js";

/** Parse the tag before an attestation or generation can rely on it. */
export function parseYardResidencyTag(entry: JsonValue | undefined) {
	if (!isJsonString(entry))
		throw new TypeError("residency tag must be a string");
	const separator = entry.indexOf(":");
	if (separator !== -1) parseDataClassification(entry.slice(0, separator));
	return parseJurisdictionId(
		separator === -1 ? entry : entry.slice(separator + 1),
	);
}

/** Direct generation callers must supply a valid residency list as well. */
export function hasValidYardResidency(layout: YardLayout): boolean {
	if (!layout || !Array.isArray(layout.residency)) return false;
	try {
		for (const entry of layout.residency) parseYardResidencyTag(entry);
		return true;
	} catch {
		return false;
	}
}

import { isJsonString } from "./json.js";
import type { SecretRef } from "./types.js";

export function secretRef(ref: string): SecretRef {
	if (!isJsonString(ref) || ref.length === 0) {
		throw new TypeError("secretRef value reference must be a non-empty string");
	}

	return Object.freeze({
		kind: "secret-ref",
		ref,
		stableId: `secret-ref:${ref}`,
		lowersTo: "hobo:sdk",
	});
}

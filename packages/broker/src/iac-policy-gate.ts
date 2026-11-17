import { isJsonNumber, isJsonObject, isJsonString } from "./json.js";
import type { GateDecision } from "./planes.js";
import { REJECTION_PLANES } from "./types.js";

// The caller has already bounded and detached this tree. Informational fields
// still have to be valid JSON so malformed decisions are not accepted.
function jsonValue<T>(value: T): boolean {
	if (value === null || value === true || value === false) return true;
	if (isJsonString(value) || isJsonNumber(value)) return true;
	if (Array.isArray(value)) return value.every(jsonValue);
	return isJsonObject(value) && Object.values(value).every(jsonValue);
}

/** Verify the complete gate value, not just its effect. */
export function validIacPolicyGate(gate: GateDecision): boolean {
	return (
		isJsonObject(gate) &&
		Object.keys(gate).length === 3 &&
		["allow", "allow-degraded", "deny", "require-approval"].includes(
			gate.effect,
		) &&
		Array.isArray(gate.reasons) &&
		gate.reasons.every(
			(reason) =>
				isJsonObject(reason) &&
				Object.keys(reason).length === 3 &&
				REJECTION_PLANES.some((plane) => plane === reason.plane) &&
				isJsonString(reason.code) &&
				isJsonString(reason.message),
		) &&
		Array.isArray(gate.events) &&
		gate.events.every((event) => isJsonObject(event) && jsonValue(event))
	);
}

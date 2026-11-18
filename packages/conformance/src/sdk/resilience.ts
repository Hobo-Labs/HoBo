import type { JsonValue } from "../json.js";
import { canonicalJson, diffJsonPaths } from "./canonical-json.js";
import type {
	LaneReport,
	ResilienceVector,
	SdkIdiomAdapter,
	VectorCaseResult,
} from "./types.js";

export async function runResilienceLane(
	vectors: readonly ResilienceVector[],
	adapter: SdkIdiomAdapter,
): Promise<LaneReport> {
	if (vectors.length === 0)
		throw new TypeError("resilience conformance requires at least one vector");
	const names = new Set<string>();
	const cases: VectorCaseResult[] = [];
	for (const vector of vectors) {
		if (
			!vector.name ||
			names.has(vector.name) ||
			!Object.hasOwn(vector, "input") ||
			!Object.hasOwn(vector, "expected")
		)
			throw new TypeError(
				"resilience vectors require unique names, inputs, and expected results",
			);
		names.add(vector.name);
		let actual: JsonValue = null;
		let observed = false;
		let reason = "resilience result differs from the expected result";
		if (!adapter.exerciseResilience) {
			reason = "SDK adapter does not execute resilience vectors";
		} else {
			try {
				actual = await adapter.exerciseResilience(vector.input);
				observed = true;
			} catch (error) {
				actual = {
					error: error instanceof Error ? error.message : String(error),
				};
				reason = "SDK adapter failed while executing the resilience vector";
			}
		}
		if (observed && canonicalJson(actual) === canonicalJson(vector.expected)) {
			cases.push({ name: vector.name, status: "passed" });
		} else {
			const paths = diffJsonPaths(vector.expected, actual);
			cases.push({
				name: vector.name,
				status: "failed",
				reason,
				expectedJson: canonicalJson(vector.expected),
				actualJson: canonicalJson(actual),
				diffPaths: paths.length > 0 ? paths : ["$"],
			});
		}
	}
	return Object.freeze({
		lane: "resilience-semantics-annex",
		status: cases.every((entry) => entry.status === "passed")
			? "passed"
			: "failed",
		cases,
	});
}

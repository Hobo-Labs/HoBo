/**
 * Realization-result conformance suite.
 *
 * Runs against any producer of `hobo.realization-result/v1` candidates — an
 * IaC adapter lane (`fromIacOutputs`), a provider driver/recipe lane
 * (`fromRecipeOutputs`), or a hand-rolled engine — and proves the three
 * contract properties: the schema round-trips losslessly, the ref-only
 * secret rule is enforced fail-closed (a result carrying a raw secret value
 * must be rejected, never emitted), and resource/binding ordering is
 * deterministic across repeated production.
 */

import {
	parseRealizationResult,
	REALIZATION_RESULT_SCHEMA,
	type RealizationResult,
	RealizationResultParseError,
} from "@hobo/core";
import type { JsonValue } from "../json.js";

import type { AssertionStatus } from "./eventstore.js";

// public-contract: version pin for the realization-result conformance contract.
export const REALIZATION_RESULT_CONFORMANCE_CONTRACT =
	"hobo.realization-result-conformance/v1";

/**
 * Scenarios a producer under test must know how to emit:
 * - `happy` — its canonical well-formed result (>= 1 resource).
 * - `raw-secret` — the lane through which a raw secret value would leak;
 *   the producer must either throw `RealizationResultParseError` itself or
 *   emit a candidate the parser rejects.
 * - `unordered` — the happy content produced from unordered inputs, with at
 *   least two resources and two bindings so ordering is actually probed.
 */
export type RealizationResultScenario = "happy" | "raw-secret" | "unordered";

export type RealizationResultAssertion =
	| "schemaRoundTrip"
	| "refOnlySecretsEnforced"
	| "deterministicResourceOrder"
	| "deterministicBindingOrder";

export interface RealizationResultConformanceReport {
	readonly contract: typeof REALIZATION_RESULT_CONFORMANCE_CONTRACT;
	readonly producer: string;
	readonly assertions: RealizationAssertions;
}

export interface RealizationAssertions {
	readonly schemaRoundTrip: AssertionStatus;
	readonly refOnlySecretsEnforced: AssertionStatus;
	readonly deterministicResourceOrder: AssertionStatus;
	readonly deterministicBindingOrder: AssertionStatus;
}

export type ProduceRealizationResult = (
	scenario: RealizationResultScenario,
) => JsonValue | Promise<JsonValue>;

export async function runRealizationResultConformance(
	produce: ProduceRealizationResult,
	options: { readonly producer?: string } = {},
): Promise<RealizationResultConformanceReport> {
	if (!(produce instanceof Function)) {
		throw new TypeError("produce must be a function");
	}

	const producer = options.producer ?? "unknown-producer";
	const ordering = await provesDeterministicOrdering(produce);
	const assertions: RealizationAssertions = {
		schemaRoundTrip: (await provesSchemaRoundTrip(produce)) ? "pass" : "fail",
		refOnlySecretsEnforced: (await provesRefOnlySecrets(produce))
			? "pass"
			: "fail",
		deterministicResourceOrder: ordering.resources ? "pass" : "fail",
		deterministicBindingOrder: ordering.bindings ? "pass" : "fail",
	};

	return Object.freeze({
		contract: REALIZATION_RESULT_CONFORMANCE_CONTRACT,
		producer,
		assertions: Object.freeze(assertions),
	});
}

function canonicalJson(result: RealizationResult): string {
	return JSON.stringify(result);
}

async function provesSchemaRoundTrip(
	produce: ProduceRealizationResult,
): Promise<boolean> {
	try {
		const parsed = parseRealizationResult(await produce("happy"));
		if (parsed.schema !== REALIZATION_RESULT_SCHEMA) {
			return false;
		}
		if (parsed.resources.length === 0) {
			return false;
		}
		const reparsed = parseRealizationResult(JSON.parse(canonicalJson(parsed)));
		return canonicalJson(parsed) === canonicalJson(reparsed);
	} catch {
		return false;
	}
}

async function provesRefOnlySecrets(
	produce: ProduceRealizationResult,
): Promise<boolean> {
	let candidate: JsonValue;
	try {
		candidate = await produce("raw-secret");
	} catch (error) {
		// The producer refusing to emit the leak at all is the strongest pass.
		return error instanceof RealizationResultParseError;
	}
	try {
		parseRealizationResult(candidate);
		return false;
	} catch (error) {
		return error instanceof RealizationResultParseError;
	}
}

async function provesDeterministicOrdering(
	produce: ProduceRealizationResult,
): Promise<{ resources: boolean; bindings: boolean }> {
	try {
		const first = parseRealizationResult(await produce("unordered"));
		const second = parseRealizationResult(await produce("unordered"));
		const stable = canonicalJson(first) === canonicalJson(second);
		const resourceNames = first.resources.map((resource) => resource.name);
		const bindingKeys = first.bindings.map((binding) => binding.key);
		return {
			resources: stable && resourceNames.length >= 2 && isSorted(resourceNames),
			bindings: stable && bindingKeys.length >= 2 && isSorted(bindingKeys),
		};
	} catch {
		return { resources: false, bindings: false };
	}
}

function isSorted(entries: readonly string[]): boolean {
	for (let index = 1; index < entries.length; index += 1) {
		const previous = entries[index - 1];
		const current = entries[index];
		if (previous !== undefined && current !== undefined && previous > current) {
			return false;
		}
	}
	return true;
}

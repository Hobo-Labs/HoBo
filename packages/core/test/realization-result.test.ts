import { describeConcern } from "@hobo/contract-harness";
import type { JsonObject, JsonValue } from "../src/json.js";
import {
	fromIacOutputs,
	fromRecipeOutputs,
	isSecretRefString,
	looksLikeSecretKey,
	parseRealizationResult,
	REALIZATION_RESULT_SCHEMA,
	RealizationResultParseError,
} from "../src/ports/realization-result.js";

const withSchema = (body: JsonObject = {}) => ({
	schema: REALIZATION_RESULT_SCHEMA,
	...body,
});

function rejectionOf(run: () => JsonValue, secrets: readonly string[]) {
	try {
		run();
		return { threw: false };
	} catch (error) {
		const typed =
			error instanceof RealizationResultParseError ? error : undefined;
		const message = error instanceof Error ? error.message : String(error);
		return {
			threw: true,
			typed: typed !== undefined,
			rejection: typed !== undefined ? typed.rejection : null,
			received: typed !== undefined ? (typed.received ?? null) : null,
			leaks: secrets.filter((secret) => message.includes(secret)),
		};
	}
}

const names = (result: { resources: readonly unknown[] }) =>
	(result.resources as readonly Record<string, string>[]).map((resource) => ({
		name: resource.name,
		resourceClass: resource.resourceClass,
		providerId: resource.providerId,
	}));

describeConcern("realization result", {
	cases: `${import.meta.dirname}/realization-result.cases.jsonl`,
	subject: () => ({
		parse: (body?: JsonObject) => parseRealizationResult(withSchema(body)),
		parseRejection: (body: JsonValue, secrets: readonly string[] = []) =>
			rejectionOf(() => parseRealizationResult(body), secrets),
		isRoundTripStable: (body?: JsonObject) => {
			const once = parseRealizationResult(withSchema(body));
			const twice = parseRealizationResult(JSON.parse(JSON.stringify(once)));
			return JSON.stringify(once) === JSON.stringify(twice);
		},
		looksLikeSecretKey,
		isSecretRefString,
		iacOutputs: (triple: Parameters<typeof fromIacOutputs>[0]) => {
			const parsed = fromIacOutputs(triple);
			return {
				resources: names(parsed),
				values: parsed.values,
				bindingKeys: parsed.bindings.map((binding) => binding.key),
				secrets: parsed.secrets,
			};
		},
		iacRejection: (
			triple: Parameters<typeof fromIacOutputs>[0],
			secrets: readonly string[] = [],
		) => rejectionOf(() => fromIacOutputs(triple), secrets),
		recipeOutputs: (
			result: Parameters<typeof fromRecipeOutputs>[0],
			options?: Parameters<typeof fromRecipeOutputs>[1],
		) => {
			const parsed = fromRecipeOutputs(result, options);
			return { resources: names(parsed), secrets: parsed.secrets };
		},
		recipeRejection: (
			result: Parameters<typeof fromRecipeOutputs>[0],
			secrets: readonly string[] = [],
		) => rejectionOf(() => fromRecipeOutputs(result), secrets),
	}),
});

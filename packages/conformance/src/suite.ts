import { isJsonObject } from "./json.js";
import {
	type ConformanceSuite,
	type ConformanceSuiteDefinition,
	SUITE_SCHEMA,
	type SuiteCase,
} from "./types.js";

export function createConformanceSuite(
	definition: ConformanceSuiteDefinition,
): ConformanceSuite {
	if (!definition || !isJsonObject(definition)) {
		throw new TypeError("conformance suite definition is required");
	}
	if (!definition.id) {
		throw new TypeError("conformance suite id is required");
	}
	if (!definition.port?.wit) {
		throw new TypeError("conformance suite port.wit is required");
	}
	if (
		!Array.isArray(definition.port.functions) ||
		definition.port.functions.length === 0
	) {
		throw new TypeError(
			"conformance suite port.functions must name at least one function",
		);
	}
	if (!Array.isArray(definition.cases) || definition.cases.length === 0) {
		throw new TypeError(
			"conformance suite cases must contain at least one case",
		);
	}

	const portFunctions = unique(definition.port.functions);
	const requiredFunctions = unique(
		definition.coverage?.requiredFunctions ?? portFunctions,
	);
	const cases: SuiteCase[] = definition.cases.map((suiteCase) => ({
		...cloneData(suiteCase),
		tier: suiteCase.tier ?? "local",
		exercises: suiteCase.exercises ?? [suiteCase.call.function],
	}));

	return Object.freeze({
		schema: SUITE_SCHEMA,
		id: definition.id,
		port: Object.freeze({
			...cloneData(definition.port),
			functions: portFunctions,
		}),
		coverage: Object.freeze({
			...cloneData(definition.coverage),
			requiredFunctions,
		}),
		// SAFETY: assertion to `Object.freeze(cases) as SuiteCase[]` is required at this boundary.
		cases: Object.freeze(cases) as SuiteCase[],
	});
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function cloneData<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

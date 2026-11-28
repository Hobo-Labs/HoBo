import { must } from "@hobo/core/total-access";
import { firstDiff } from "./diff.js";
import { findLanguageSpecificGoldenIrField } from "./golden-ir.js";
import { isJsonObject, isJsonString, type JsonObject } from "./json.js";
import { projectPortSuiteReport } from "./report.js";
import { createCaseContext } from "./seed.js";
import { createConformanceSuite } from "./suite.js";
import {
	type AdapterResult,
	type CaseAssertion,
	type ConformanceAdapter,
	type ConformanceFailure,
	type ConformanceRunEvent,
	type ConformanceSuite,
	type ConformanceSuiteDefinition,
	type ConformanceTier,
	DEFAULT_SEED,
	type RunConformanceSuiteOptions,
	type SuiteCase,
} from "./types.js";

export async function runConformanceSuite(
	definition: ConformanceSuiteDefinition | ConformanceSuite,
	adapterOrId: ConformanceAdapter | string,
	options: RunConformanceSuiteOptions = {},
): Promise<ReturnType<typeof projectPortSuiteReport>> {
	const suite =
		"schema" in definition ? definition : createConformanceSuite(definition);
	const seed = options.seed ?? DEFAULT_SEED;
	// SAFETY: assertion to `["local"] as ConformanceTier[]` is required at this boundary.
	const tiers = options.tiers ?? (["local"] as ConformanceTier[]);
	const adapter = resolveAdapter(adapterOrId, options);
	const adapterId = adapter.id ?? options.adapterId ?? "anonymous-adapter";
	const events: ConformanceRunEvent[] = [];

	events.push({
		type: "conformance.RunStarted",
		suiteId: suite.id,
		port: suite.port.wit,
		adapterId,
		seed,
		caseIds: suite.cases.map((suiteCase) => suiteCase.id),
	});

	const exercisedFunctions = new Set<string>();

	for (const suiteCase of suite.cases) {
		const functionName = suiteCase.call.function;
		const tierSelected = tiers.includes(suiteCase.tier);

		if (!tierSelected) {
			events.push({
				type: "conformance.CaseChecked",
				caseId: suiteCase.id,
				function: functionName,
				tier: suiteCase.tier,
				skipped: true,
				failures: [],
				assertions: [],
			});
			continue;
		}

		for (const exercisedFunction of suiteCase.exercises ?? [functionName]) {
			if (exercisedFunction) {
				exercisedFunctions.add(exercisedFunction);
			}
		}

		const caseResult = await evaluateCase(
			suiteCase,
			adapter,
			seed,
			options.determinism !== false,
		);
		events.push({
			type: "conformance.CaseChecked",
			caseId: suiteCase.id,
			function: functionName,
			tier: suiteCase.tier,
			skipped: false,
			failures: caseResult.failures,
			assertions: caseResult.assertions,
		});
	}

	const requiredFunctions = suite.coverage.requiredFunctions;
	const exercised = requiredFunctions.filter((functionName) =>
		exercisedFunctions.has(functionName),
	);
	const unexercisedFunctions = requiredFunctions.filter(
		(functionName) => !exercisedFunctions.has(functionName),
	);

	const coverage = {
		exercisedFunctions: exercised,
		requiredFunctions,
		unexercisedFunctions,
	};

	const coverageFailures: ConformanceFailure[] = [];
	const claimedUnexercised = requiredFunctions.filter((functionName) => {
		if (exercisedFunctions.has(functionName)) {
			return false;
		}

		const selectedTierCases = suite.cases.filter(
			(suiteCase) =>
				tiers.includes(suiteCase.tier) &&
				(suiteCase.exercises ?? [suiteCase.call.function]).includes(
					functionName,
				),
		);
		const skippedTierCases = suite.cases.filter(
			(suiteCase) =>
				!tiers.includes(suiteCase.tier) &&
				(suiteCase.exercises ?? [suiteCase.call.function]).includes(
					functionName,
				),
		);

		return !(selectedTierCases.length === 0 && skippedTierCases.length > 0);
	});

	if (claimedUnexercised.length > 0) {
		coverageFailures.push({
			code: "coverage.claimed-unexercised",
			functions: claimedUnexercised,
		});
	}

	events.push({
		type: "conformance.CoverageEvaluated",
		coverage,
		failures: coverageFailures,
	});

	const allFailures = [
		...events
			.filter(
				(
					event,
				): event is Extract<
					ConformanceRunEvent,
					{ type: "conformance.CaseChecked" }
				> => event.type === "conformance.CaseChecked",
			)
			.flatMap((event) => event.failures),
		...coverageFailures,
	];
	const failureCodes = unique(allFailures.map((failure) => failure.code));

	events.push({
		type: "conformance.RunCompleted",
		ok: allFailures.length === 0,
		failureCodes,
	});

	return projectPortSuiteReport(events);
}

function resolveAdapter(
	adapterOrId: ConformanceAdapter | string,
	options: RunConformanceSuiteOptions,
): ConformanceAdapter {
	if (!isJsonString(adapterOrId)) {
		return adapterOrId;
	}

	const adapter = options.registry?.get(adapterOrId);
	if (!adapter) {
		throw new TypeError(`adapter not found in registry: ${adapterOrId}`);
	}

	return adapter;
}

async function evaluateCase(
	suiteCase: SuiteCase,
	adapter: ConformanceAdapter,
	seed: string,
	determinism: boolean,
): Promise<{ failures: ConformanceFailure[]; assertions: CaseAssertion[] }> {
	const failures: ConformanceFailure[] = [];
	const assertions: CaseAssertion[] = [];
	const functionName = suiteCase.call.function;

	if (!(adapter[functionName] instanceof Function)) {
		failures.push({
			code: "adapter.missing-function",
			caseId: suiteCase.id,
			function: functionName,
		});
		return { failures, assertions };
	}

	const firstRun = await runAdapterCase(suiteCase, adapter, seed);
	if (firstRun.error) {
		failures.push(firstRun.error);
		return { failures, assertions };
	}

	if (determinism) {
		const secondRun = await runAdapterCase(suiteCase, adapter, seed);
		if (secondRun.error) {
			failures.push({
				...secondRun.error,
				code: "determinism.second-run-failed",
			});
			return { failures, assertions };
		}

		const determinismDiff = firstDiff(firstRun.result, secondRun.result);
		if (determinismDiff) {
			failures.push({
				code: "determinism.seed-drift",
				caseId: suiteCase.id,
				function: functionName,
				seed,
				diff: determinismDiff,
			});
		}
	}

	compareExpected({
		assertions,
		failures,
		suiteCase,
		actual: must(firstRun.result),
	});

	return { failures, assertions };
}

async function runAdapterCase(
	suiteCase: SuiteCase,
	adapter: ConformanceAdapter,
	seed: string,
): Promise<{ result?: AdapterResult; error?: ConformanceFailure }> {
	const functionName = suiteCase.call.function;

	try {
		const adapterFn = adapter[functionName];
		if (!(adapterFn instanceof Function)) {
			throw new TypeError(`missing adapter function: ${functionName}`);
		}

		const result = await adapterFn(
			cloneData(suiteCase.call.input),
			createCaseContext(seed, suiteCase.id),
		);
		return { result: normalizeAdapterResult(result) };
	} catch (error) {
		return {
			error: {
				code: "adapter.threw",
				caseId: suiteCase.id,
				function: functionName,
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

function compareExpected({
	assertions,
	failures,
	suiteCase,
	actual,
}: {
	assertions: CaseAssertion[];
	failures: ConformanceFailure[];
	suiteCase: SuiteCase;
	actual: AdapterResult;
}): void {
	const expected = suiteCase.expect ?? {};
	const functionName = suiteCase.call.function;

	if (Object.hasOwn(expected, "output")) {
		const outputDiff = firstDiff(expected.output, actual.output);
		if (outputDiff) {
			failures.push({
				code: "adapter.output-mismatch",
				caseId: suiteCase.id,
				function: functionName,
				diff: outputDiff,
			});
		} else {
			assertions.push({
				code: "adapter.output",
				caseId: suiteCase.id,
				function: functionName,
			});
		}
	}

	if (Object.hasOwn(expected, "goldenIr")) {
		const leak = findLanguageSpecificGoldenIrField(actual.goldenIr);
		if (leak) {
			failures.push({
				code: "golden-ir.language-leak",
				caseId: suiteCase.id,
				function: functionName,
				path: leak.path,
			});
		}

		const goldenIrDiff = firstDiff(expected.goldenIr, actual.goldenIr);
		if (goldenIrDiff) {
			failures.push({
				code: "golden-ir.mismatch",
				caseId: suiteCase.id,
				function: functionName,
				diff: goldenIrDiff,
			});
		} else {
			assertions.push({
				code: "golden-ir.equivalence",
				caseId: suiteCase.id,
				function: functionName,
			});
		}
	}

	if (Object.hasOwn(expected, "replayTrace")) {
		const traceDiff = firstDiff(expected.replayTrace, actual.replayTrace);
		if (traceDiff) {
			failures.push({
				code: "trace-replay.regression",
				caseId: suiteCase.id,
				function: functionName,
				diff: traceDiff,
			});
		} else {
			assertions.push({
				code: "trace-replay.equivalence",
				caseId: suiteCase.id,
				function: functionName,
			});
		}
	}
}

function normalizeAdapterResult<T>(result: T): AdapterResult {
	if (isPlainObject(result) && hasHarnessResultLayout(result)) {
		return {
			output: cloneData(result.output),
			goldenIr: cloneData(result.goldenIr ?? []),
			replayTrace: cloneData(result.replayTrace ?? result.trace ?? []),
		};
	}

	return {
		output: cloneData(result),
		goldenIr: [],
		replayTrace: [],
	};
}

function hasHarnessResultLayout(result: JsonObject): boolean {
	return (
		Object.hasOwn(result, "output") ||
		Object.hasOwn(result, "goldenIr") ||
		Object.hasOwn(result, "replayTrace") ||
		Object.hasOwn(result, "trace")
	);
}

function cloneData<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

function isPlainObject<T>(value: T): value is T & JsonObject {
	return value !== null && isJsonObject(value) && !Array.isArray(value);
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

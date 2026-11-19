import { isDeepStrictEqual, types } from "node:util";
import { WorkflowFailure } from "./errors.js";
import {
	cloneAsJson,
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

function isStoredJsonValue(value: JsonValue): boolean {
	if (value === null) return true;
	if (isJsonString(value) || isJsonBoolean(value)) return true;
	if (isJsonNumber(value)) return Number.isFinite(value);
	if (isJsonArray(value))
		return value.every((entry) => isStoredJsonValue(entry));
	if (isJsonObject(value)) {
		return Object.keys(value).every((key) => {
			const entry = value[key];
			return entry !== undefined && isStoredJsonValue(entry);
		});
	}
	return false;
}

export type ParsedRunStarted = {
	args: JsonValue | null;
	seed: string;
	workflowName?: string;
};

export function parseRunStartedFact(
	data: JsonValue,
	defaultSeed: string,
): ParsedRunStarted {
	if (!isJsonObject(data)) throw new TypeError("invalid run.Started");
	const allowed = new Set(["args", "seed", "workflowName"]);
	for (const key of Object.keys(data)) {
		if (!allowed.has(key)) throw new TypeError("invalid run.Started");
	}
	if (!("args" in data)) throw new TypeError("invalid run.Started");
	const rawArgs = data.args;
	let args: JsonValue | null;
	if (rawArgs === null) args = null;
	else if (!isStoredJsonValue(rawArgs)) throw new TypeError("invalid run.Started");
	else args = rawArgs;
	const hasWorkflowName = "workflowName" in data;
	let workflowName: string | undefined;
	if (hasWorkflowName) {
		if (!isJsonString(data.workflowName))
			throw new TypeError("invalid run.Started");
		workflowName = data.workflowName;
	}
	let runSeed: string;
	if ("seed" in data) {
		if (!isJsonString(data.seed)) throw new TypeError("invalid run.Started");
		runSeed = data.seed;
	} else if (hasWorkflowName) {
		throw new TypeError("invalid run.Started");
	} else {
		runSeed = defaultSeed;
	}
	const parsed: ParsedRunStarted = { args, seed: runSeed };
	if (workflowName !== undefined) parsed.workflowName = workflowName;
	return parsed;
}

export type ParsedRunFailed = {
	message: string;
	step?: string;
};

export type ParsedRunStepFailed = {
	name: string;
	index: number;
	message: string;
};

export function parseRunStepFailedFact(data: JsonValue): ParsedRunStepFailed {
	if (!isJsonObject(data)) throw new TypeError("invalid run.StepFailed");
	const allowed = new Set(["name", "index", "message"]);
	for (const key of Object.keys(data)) {
		if (!allowed.has(key)) throw new TypeError("invalid run.StepFailed");
	}
	if (!isJsonString(data.name)) throw new TypeError("invalid run.StepFailed");
	if (!isJsonNumber(data.index) || !Number.isInteger(data.index) || data.index < 0)
		throw new TypeError("invalid run.StepFailed");
	if (!isJsonString(data.message)) throw new TypeError("invalid run.StepFailed");
	return { name: data.name, index: data.index, message: data.message };
}

export function parseRunCompletedFact(data: JsonValue): JsonValue | undefined {
	if (!isJsonObject(data)) throw new TypeError("invalid run.Completed");
	const allowed = new Set(["result"]);
	for (const key of Object.keys(data)) {
		if (!allowed.has(key)) throw new TypeError("invalid run.Completed");
	}
	if (!("result" in data) || data.result === undefined) return undefined;
	if (!isStoredJsonValue(data.result)) throw new TypeError("invalid run.Completed");
	return data.result;
}

export function parseRunStepCompletedResult(data: JsonValue): JsonValue | undefined {
	if (!isJsonObject(data)) throw new TypeError("invalid run.StepCompleted");
	const allowed = new Set(["name", "index", "result"]);
	for (const key of Object.keys(data)) {
		if (!allowed.has(key)) throw new TypeError("invalid run.StepCompleted");
	}
	if (!isJsonString(data.name)) throw new TypeError("invalid run.StepCompleted");
	if (
		!isJsonNumber(data.index) ||
		!Number.isInteger(data.index) ||
		data.index < 0
	)
		throw new TypeError("invalid run.StepCompleted");
	if (!("result" in data) || data.result === undefined) return undefined;
	if (!isStoredJsonValue(data.result))
		throw new TypeError("invalid run.StepCompleted");
	return readJournaledWorkflowResult(data.result);
}

export function replayStepCompletedResult<T>(data: JsonValue): T {
	const journaled = parseRunStepCompletedResult(data);
	if (journaled === undefined) throw new TypeError("invalid run.StepCompleted");
	const replayed = terminalCompletedHandleResult<T>(journaled);
	if (replayed === undefined) throw new TypeError("invalid run.StepCompleted");
	return replayed;
}

export function parseRunFailedFact(data: JsonValue): ParsedRunFailed {
	if (!isJsonObject(data)) throw new TypeError("invalid run.Failed");
	const allowed = new Set(["message", "step"]);
	for (const key of Object.keys(data)) {
		if (!allowed.has(key)) throw new TypeError("invalid run.Failed");
	}
	if (!isJsonString(data.message)) throw new TypeError("invalid run.Failed");
	const parsed: ParsedRunFailed = { message: data.message };
	if ("step" in data) {
		if (!isJsonString(data.step)) throw new TypeError("invalid run.Failed");
		parsed.step = data.step;
	}
	return parsed;
}

export function requireWorkflowRunId(runId: string): string {
	if (Object(runId) === runId || !isJsonString(runId) || runId.length === 0)
		throw new TypeError("workflow runId must be a non-empty string");
	return runId;
}

function isReproducibleJsonValue<T>(value: T, seen: Set<object>): boolean {
	if (value === null) return true;
	const object: object = Object(value);
	if (object !== value) {
		return (
			isJsonString(value) ||
			isJsonBoolean(value) ||
			(isJsonNumber(value) && Number.isFinite(value) && !Object.is(value, -0))
		);
	}
	if (types.isProxy(object) || seen.has(object)) return false;
	seen.add(object);
	const array = Array.isArray(value);
	if (
		Object.getPrototypeOf(object) !==
			(array ? Array.prototype : Object.prototype) ||
		!Object.isExtensible(object) ||
		Object.getOwnPropertySymbols(object).length !== 0
	)
		return false;
	const names = Object.getOwnPropertyNames(object);
	if (array && names.length !== value.length + 1) return false;
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(object, name);
		if (!descriptor || !("value" in descriptor)) return false;
		if (array && name === "length") {
			if (
				!descriptor.writable ||
				descriptor.enumerable ||
				descriptor.configurable
			)
				return false;
			continue;
		}
		if (array) {
			const index = Number(name);
			if (
				!Number.isSafeInteger(index) ||
				index < 0 ||
				index >= value.length ||
				String(index) !== name
			)
				return false;
		}
		if (
			!descriptor.enumerable ||
			!descriptor.writable ||
			!descriptor.configurable
		)
			return false;
		if (!isReproducibleJsonValue(descriptor.value, seen)) return false;
	}
	return true;
}

function faithfullyReproduces<T>(
	original: T,
	captured: JsonValue,
): captured is T & JsonValue {
	return isDeepStrictEqual(original, captured);
}

function captureWorkflowValue<T>(value: T): T {
	if (!isReproducibleJsonValue(value, new Set())) throw new TypeError();
	const captured = cloneAsJson(value);
	if (!faithfullyReproduces(value, captured)) throw new TypeError();
	return captured;
}

export function captureWorkflowInput<T>(input: T): T {
	try {
		return captureWorkflowValue(input);
	} catch {
		throw new TypeError("workflow input must be JSON-normalized");
	}
}

export function captureWorkflowResult<T>(result: T, step?: string): T {
	if (result === undefined) return result;
	try {
		return captureWorkflowValue(result);
	} catch {
		throw new WorkflowFailure(
			"workflow result must be JSON-normalized",
			step === undefined ? {} : { step },
		);
	}
}

export function readJournaledWorkflowResult(
	result: JsonValue | undefined,
): JsonValue | undefined {
	if (result === undefined) return undefined;
	return captureWorkflowValue(result);
}

export function terminalCompletedHandleResult<R>(
	journaled: JsonValue | undefined,
): R | undefined {
	if (journaled === undefined) return undefined;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: journaled payloads are re-validated through readJournaledWorkflowResult.
	return journaled as R;
}

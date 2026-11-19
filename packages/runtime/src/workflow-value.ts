import { isDeepStrictEqual, types } from "node:util";
import { WorkflowFailure } from "./errors.js";
import {
	cloneAsJson,
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

function isStoredJsonValue(value: JsonValue): boolean {
	if (value === null) return true;
	if (isJsonString(value) || isJsonBoolean(value)) return true;
	if (isJsonNumber(value))
		return Number.isFinite(value) && !Object.is(value, -0);
	if (isJsonArray(value)) {
		if (Object.getOwnPropertySymbols(value).length !== 0) return false;
		const names = Object.getOwnPropertyNames(value);
		if (names.length !== value.length + 1) return false;
		for (const name of names) {
			if (name === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
				return false;
			const index = Number(name);
			if (
				!Number.isSafeInteger(index) ||
				index < 0 ||
				index >= value.length ||
				String(index) !== name
			)
				return false;
		}
		for (let index = 0; index < value.length; index += 1) {
			if (!Object.hasOwn(value, String(index))) return false;
			const entry = value[index];
			if (entry === undefined || !isStoredJsonValue(entry)) return false;
		}
		return true;
	}
	if (isJsonObject(value)) {
		if (Object.getOwnPropertySymbols(value).length !== 0) return false;
		for (const key of Object.getOwnPropertyNames(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
				return false;
			const entry = value[key];
			if (entry === undefined || !isStoredJsonValue(entry)) return false;
		}
		return true;
	}
	return false;
}

function assertOnlyFactKeys(
	data: JsonObject,
	allowed: ReadonlySet<string>,
	message: string,
): void {
	if (Object.getOwnPropertySymbols(data).length !== 0)
		throw new TypeError(message);
	for (const key of Object.getOwnPropertyNames(data)) {
		const descriptor = Object.getOwnPropertyDescriptor(data, key);
		if (
			!descriptor ||
			!("value" in descriptor) ||
			!descriptor.enumerable ||
			!allowed.has(key)
		)
			throw new TypeError(message);
	}
}

function isBoundedJournalIndex(value: JsonValue | undefined): value is number {
	return (
		isJsonNumber(value) &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= 1_000_000 &&
		!Object.is(value, -0)
	);
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
	assertOnlyFactKeys(
		data,
		new Set(["args", "seed", "workflowName"]),
		"invalid run.Started",
	);
	const hasWorkflowName = Object.hasOwn(data, "workflowName");
	let args: JsonValue | null;
	if (!Object.hasOwn(data, "args")) {
		if (hasWorkflowName) throw new TypeError("invalid run.Started");
		args = null;
	} else {
		const rawArgs = data.args;
		if (rawArgs === null) args = null;
		else if (rawArgs === undefined || !isStoredJsonValue(rawArgs))
			throw new TypeError("invalid run.Started");
		else args = rawArgs;
	}
	let workflowName: string | undefined;
	if (hasWorkflowName) {
		if (!isJsonString(data.workflowName))
			throw new TypeError("invalid run.Started");
		workflowName = data.workflowName;
	}
	let runSeed: string;
	if (Object.hasOwn(data, "seed")) {
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

export type ParsedRunStepScheduled = {
	name: string;
	index: number;
};

export function parseRunStepScheduledFact(
	data: JsonValue,
): ParsedRunStepScheduled {
	if (!isJsonObject(data)) throw new TypeError("invalid run.StepScheduled");
	assertOnlyFactKeys(
		data,
		new Set(["name", "index"]),
		"invalid run.StepScheduled",
	);
	if (!isJsonString(data.name))
		throw new TypeError("invalid run.StepScheduled");
	if (!isBoundedJournalIndex(data.index))
		throw new TypeError("invalid run.StepScheduled");
	return { name: data.name, index: data.index };
}

export type ParsedRunSleepScheduled = {
	delayMs: number;
	index: number;
	label?: string;
};

export function parseRunSleepScheduledFact(
	data: JsonValue,
): ParsedRunSleepScheduled {
	if (!isJsonObject(data)) throw new TypeError("invalid run.SleepScheduled");
	assertOnlyFactKeys(
		data,
		new Set(["delayMs", "index", "label"]),
		"invalid run.SleepScheduled",
	);
	if (
		!Object.hasOwn(data, "delayMs") ||
		!isJsonNumber(data.delayMs) ||
		Object.is(data.delayMs, -0)
	)
		throw new TypeError("invalid run.SleepScheduled");
	const delayMs = data.delayMs;
	if (!Number.isSafeInteger(delayMs) || delayMs < 0 || Object.is(delayMs, -0)) {
		throw new TypeError("invalid run.SleepScheduled");
	}
	if (!Object.hasOwn(data, "index") || !isBoundedJournalIndex(data.index))
		throw new TypeError("invalid run.SleepScheduled");
	const parsed: ParsedRunSleepScheduled = {
		delayMs,
		index: data.index,
	};
	if (Object.hasOwn(data, "label")) {
		if (!isJsonString(data.label))
			throw new TypeError("invalid run.SleepScheduled");
		parsed.label = data.label;
	}
	return parsed;
}

export function parseRunStepFailedFact(data: JsonValue): ParsedRunStepFailed {
	if (!isJsonObject(data)) throw new TypeError("invalid run.StepFailed");
	assertOnlyFactKeys(
		data,
		new Set(["name", "index", "message"]),
		"invalid run.StepFailed",
	);
	if (!isJsonString(data.name)) throw new TypeError("invalid run.StepFailed");
	if (!isBoundedJournalIndex(data.index))
		throw new TypeError("invalid run.StepFailed");
	if (!isJsonString(data.message))
		throw new TypeError("invalid run.StepFailed");
	return { name: data.name, index: data.index, message: data.message };
}

export function parseRunCompletedFact(data: JsonValue): JsonValue | undefined {
	if (!isJsonObject(data)) throw new TypeError("invalid run.Completed");
	assertOnlyFactKeys(data, new Set(["result"]), "invalid run.Completed");
	if (!Object.hasOwn(data, "result") || data.result === undefined)
		return undefined;
	if (!isStoredJsonValue(data.result))
		throw new TypeError("invalid run.Completed");
	return data.result;
}

export type ParsedRunStepCompleted = {
	name: string;
	index: number;
	result?: JsonValue;
};

export function parseRunStepCompletedFact(
	data: JsonValue,
): ParsedRunStepCompleted {
	if (!isJsonObject(data)) throw new TypeError("invalid run.StepCompleted");
	assertOnlyFactKeys(
		data,
		new Set(["name", "index", "result"]),
		"invalid run.StepCompleted",
	);
	if (!isJsonString(data.name))
		throw new TypeError("invalid run.StepCompleted");
	if (!isBoundedJournalIndex(data.index))
		throw new TypeError("invalid run.StepCompleted");
	const parsed: ParsedRunStepCompleted = {
		name: data.name,
		index: data.index,
	};
	if (Object.hasOwn(data, "result") && data.result !== undefined) {
		if (!isStoredJsonValue(data.result))
			throw new TypeError("invalid run.StepCompleted");
		const journaled = readJournaledWorkflowResult(data.result);
		if (journaled !== undefined) {
			parsed.result = journaled;
		}
	}
	return parsed;
}

export function replayStepCompletedResult<T>(data: JsonValue): T {
	const step = parseRunStepCompletedFact(data);
	if (step.result === undefined) {
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: void steps journal an explicit undefined result field.
		return undefined as T;
	}
	const replayed = terminalCompletedHandleResult<T>(step.result);
	if (replayed === undefined) {
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: undefined is the declared void-step replay outcome.
		return undefined as T;
	}
	return replayed;
}

export function parseRunFailedFact(data: JsonValue): ParsedRunFailed {
	if (!isJsonObject(data)) throw new TypeError("invalid run.Failed");
	assertOnlyFactKeys(data, new Set(["message", "step"]), "invalid run.Failed");
	if (!isJsonString(data.message)) throw new TypeError("invalid run.Failed");
	const parsed: ParsedRunFailed = { message: data.message };
	if (Object.hasOwn(data, "step")) {
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
	return isDeepStrictEqual(
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: `isReproducibleJsonValue` already validated JSON shape.
		cloneAsJson(original as JsonValue),
		captured,
	);
}

function captureWorkflowValue<T>(value: T): T {
	if (!isReproducibleJsonValue(value, new Set()))
		throw new TypeError("workflow value must be JSON-normalized");
	const captured = cloneAsJson(value);
	if (!faithfullyReproduces(value, captured))
		throw new TypeError("workflow value must be JSON-normalized");
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

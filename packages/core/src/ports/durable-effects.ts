import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "../json.js";
import { type DurableEffectInput, EventStoreParseError } from "./eventstore.js";

function requiredText<T>(value: T, path: string): void {
	if (!isJsonString(value) || value.trim().length === 0)
		throw new EventStoreParseError(path, "non-empty string", undefined);
}

function optionalText<T>(value: T, path: string): void {
	if (value !== undefined) requiredText(value, path);
}

function timestamp<T>(value: T, path: string): void {
	requiredText(value, path);
	if (!isJsonString(value) || Number.isNaN(Date.parse(value)))
		throw new EventStoreParseError(path, "timestamp", undefined);
}

function optionalTimestamp<T>(value: T, path: string): void {
	if (value !== undefined) timestamp(value, path);
}

function integer<T>(value: T, path: string, minimum: number): void {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < minimum)
		throw new EventStoreParseError(
			path,
			`safe integer >= ${minimum}`,
			undefined,
		);
}

function jsonValue<T>(value: T, parents: Set<object>): boolean {
	if (value === null || isJsonString(value) || isJsonBoolean(value))
		return true;
	if (isJsonNumber(value)) return Number.isFinite(value);
	if (!isJsonArray(value) && !isJsonObject(value)) return false;
	if (parents.has(value)) return false;
	parents.add(value);
	const valid = (isJsonArray(value) ? value : Object.values(value)).every(
		(entry) => jsonValue(entry, parents),
	);
	parents.delete(value);
	return valid;
}

function requiredJson<T>(value: T, path: string): void {
	if (!jsonValue(value, new Set()))
		throw new EventStoreParseError(path, "JSON value", undefined);
}

export function parseDurableEffect(
	input: DurableEffectInput,
): DurableEffectInput {
	let effect: DurableEffectInput;
	try {
		effect = structuredClone(input);
	} catch {
		throw new EventStoreParseError(
			"effect",
			"cloneable durable effect",
			undefined,
		);
	}
	if (!isJsonObject(effect))
		throw new EventStoreParseError(
			"effect",
			"durable effect object",
			undefined,
		);
	switch (effect.kind) {
		case "queue":
			requiredText(effect.queueName, "effect.queueName");
			requiredText(effect.idempotencyKey, "effect.idempotencyKey");
			requiredJson(effect.body, "effect.body");
			optionalText(effect.actorKey, "effect.actorKey");
			optionalTimestamp(effect.availableAt, "effect.availableAt");
			return effect;
		case "actor-signal":
			requiredText(effect.actorKey, "effect.actorKey");
			requiredText(effect.idempotencyKey, "effect.idempotencyKey");
			requiredJson(effect.body, "effect.body");
			return effect;
		case "timer":
			optionalText(effect.timerId, "effect.timerId");
			requiredText(effect.subjectId, "effect.subjectId");
			requiredText(effect.idempotencyKey, "effect.idempotencyKey");
			if (effect.timerKind !== "sleep" && effect.timerKind !== "reminder")
				throw new EventStoreParseError(
					"effect.timerKind",
					"sleep or reminder",
					undefined,
				);
			timestamp(effect.dueAt, "effect.dueAt");
			if (effect.payload !== undefined)
				requiredJson(effect.payload, "effect.payload");
			return effect;
		case "cron":
			requiredText(effect.scheduleId, "effect.scheduleId");
			integer(effect.everyMs, "effect.everyMs", 1);
			timestamp(effect.startAt, "effect.startAt");
			timestamp(effect.nextFireAt, "effect.nextFireAt");
			if (effect.occurrence !== undefined)
				integer(effect.occurrence, "effect.occurrence", 0);
			return effect;
		case "outbox":
			requiredText(effect.destination, "effect.destination");
			requiredText(effect.idempotencyKey, "effect.idempotencyKey");
			requiredJson(effect.payload, "effect.payload");
			optionalTimestamp(effect.availableAt, "effect.availableAt");
			if (
				effect.headers !== undefined &&
				(!isJsonObject(effect.headers) ||
					!Object.values(effect.headers).every(isJsonString))
			)
				throw new EventStoreParseError(
					"effect.headers",
					"string-valued object",
					undefined,
				);
			return effect;
		default:
			throw new EventStoreParseError(
				"effect.kind",
				"known durable effect kind",
				undefined,
			);
	}
}

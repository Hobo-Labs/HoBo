import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import { deepFreeze } from "../parse-utils.js";

// public-contract: the closed slot vocabulary provider packages bind against.
export const CAPABILITY_SLOTS = Object.freeze([
	"web",
	"api",
	"service",
	"data",
	"kv",
	"bucket",
	"queue",
	"topic",
	"secretRef",
	"webhook",
] as const);
export type CapabilitySlot = (typeof CAPABILITY_SLOTS)[number];

// public-contract: versioned identity stamped on every parsed slot binding.
export const SLOT_BINDING_CONTRACT = "hobo.slot-binding/v1";

const PROFILE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\/v[1-9][0-9]*$/u;

const CREDENTIAL_KEY_PATTERN =
	/(secret|password|token|credential|private[_-]?key|api[_-]?key)/i;

export interface SlotBindingInput {
	readonly slot: CapabilitySlot;
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties?: JsonObject;
}

export interface SlotBinding {
	readonly contract: typeof SLOT_BINDING_CONTRACT;
	readonly slot: CapabilitySlot;
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties: JsonObject;
}

export type SlotBindingErrorCode =
	| "SLOT_BINDING_SLOT_INVALID"
	| "SLOT_BINDING_PROFILE_INVALID"
	| "SLOT_BINDING_EMPTY_CONSTRAINT"
	| "SLOT_BINDING_CREDENTIAL_PROPERTY"
	| "SLOT_BINDING_PROPERTY_NOT_JSON";

export class SlotBindingError extends Error {
	readonly code: SlotBindingErrorCode;
	readonly slot?: string;

	constructor(code: SlotBindingErrorCode, message: string, slot?: JsonValue) {
		super(message);
		this.name = "SlotBindingError";
		this.code = code;
		if (isJsonString(slot)) {
			this.slot = slot;
		}
	}
}

export function slotBinding(input: SlotBindingInput): SlotBinding {
	if (input === null || !isJsonObject(input) || Array.isArray(input)) {
		throw new SlotBindingError(
			"SLOT_BINDING_SLOT_INVALID",
			`slot binding must be an object with a slot from ${CAPABILITY_SLOTS.join(" | ")}`,
		);
	}

	const slot = parseSlot(input.slot);
	const profile = parseProfile(input.profile, slot);
	const productId = parseConstraint(input.productId, "productId", slot);
	const connectivityId = parseConstraint(
		input.connectivityId,
		"connectivityId",
		slot,
	);
	if (productId === undefined && connectivityId === undefined) {
		throw new SlotBindingError(
			"SLOT_BINDING_EMPTY_CONSTRAINT",
			`slot "${slot}" binds profile "${profile}" without a productId or a connectivityId: a binding that narrows nothing cannot be satisfied by a provider, so it is refused rather than silently matching everything`,
			slot,
		);
	}

	const properties = canonicalizeProperties(input.properties, slot);

	return deepFreeze({
		contract: SLOT_BINDING_CONTRACT,
		slot,
		profile,
		...(productId !== undefined ? { productId } : undefined),
		...(connectivityId !== undefined ? { connectivityId } : undefined),
		properties,
	});
}

function parseSlot(value: JsonValue | undefined): CapabilitySlot {
	if (
		!isJsonString(value) ||
		!(CAPABILITY_SLOTS as readonly string[]).includes(value)
	) {
		throw new SlotBindingError(
			"SLOT_BINDING_SLOT_INVALID",
			`slot: expected ${CAPABILITY_SLOTS.join(" | ")}; a slot is never inferred because the wrong slot binds a capability the app never asked for`,
			value,
		);
	}
	return value as CapabilitySlot;
}

function parseProfile(
	value: JsonValue | undefined,
	slot: CapabilitySlot,
): string {
	if (!isJsonString(value) || !PROFILE_PATTERN.test(value)) {
		throw new SlotBindingError(
			"SLOT_BINDING_PROFILE_INVALID",
			`profile: expected the ADR-0151 grammar <family>.<path>/v<major> (lowercase, dot-separated, "/v" plus a major starting at 1), received ${JSON.stringify(value)}`,
			slot,
		);
	}
	return value;
}

function parseConstraint(
	value: JsonValue | undefined,
	field: string,
	slot: CapabilitySlot,
): string | undefined {
	if (value === undefined) return undefined;
	if (!isJsonString(value)) {
		throw new SlotBindingError(
			"SLOT_BINDING_EMPTY_CONSTRAINT",
			`${field}: expected a non-empty string, received ${JSON.stringify(value)}`,
			slot,
		);
	}
	if (value.trim().length === 0) return undefined;
	return value;
}

function canonicalizeProperties(
	value: JsonValue | undefined,
	slot: CapabilitySlot,
): JsonObject {
	if (value === undefined) return {};
	if (value === null || !isJsonObject(value) || Array.isArray(value)) {
		throw new SlotBindingError(
			"SLOT_BINDING_PROPERTY_NOT_JSON",
			`properties: expected a JSON object, received ${describe(value)}`,
			slot,
		);
	}
	return canonicalizeRecord(
		value as JsonObject,
		"properties",
		slot,
		new Set<JsonObject | JsonValue[]>(),
	);
}

function canonicalizeRecord(
	record: JsonObject,
	path: string,
	slot: CapabilitySlot,
	seen: Set<JsonObject | JsonValue[]>,
): JsonObject {
	enterCycleGuard(record, path, slot, seen);
	const out: JsonBag = {};
	for (const key of Object.keys(record).sort(compare)) {
		if (CREDENTIAL_KEY_PATTERN.test(key)) {
			throw new SlotBindingError(
				"SLOT_BINDING_CREDENTIAL_PROPERTY",
				`${path}.${key}: slot binding properties must not carry credentials — bind a secretRef slot and let the provider resolve it at deploy time`,
				slot,
			);
		}
		out[key] = canonicalizeValue(record[key], `${path}.${key}`, slot, seen);
	}
	seen.delete(record);
	return out;
}

function canonicalizeValue(
	value: JsonValue | undefined,
	path: string,
	slot: CapabilitySlot,
	seen: Set<JsonObject | JsonValue[]>,
): JsonValue {
	if (value === null || isJsonBoolean(value) || isJsonString(value)) {
		return value;
	}
	if (isJsonNumber(value)) {
		if (!Number.isFinite(value)) {
			throw new SlotBindingError(
				"SLOT_BINDING_PROPERTY_NOT_JSON",
				`${path}: ${String(value)} has no JSON representation`,
				slot,
			);
		}
		return value;
	}
	if (Array.isArray(value)) {
		enterCycleGuard(value, path, slot, seen);
		const out = value.map((entry, index) =>
			canonicalizeValue(entry, `${path}[${index}]`, slot, seen),
		);
		seen.delete(value);
		return out;
	}
	if (isPlainObject(value)) {
		return canonicalizeRecord(value, path, slot, seen);
	}
	throw new SlotBindingError(
		"SLOT_BINDING_PROPERTY_NOT_JSON",
		`${path}: expected a JSON-safe value (null, boolean, finite number, string, array, plain object), received ${describe(value)}`,
		slot,
	);
}

function enterCycleGuard(
	value: JsonObject | JsonValue[],
	path: string,
	slot: CapabilitySlot,
	seen: Set<JsonObject | JsonValue[]>,
): void {
	if (seen.has(value)) {
		throw new SlotBindingError(
			"SLOT_BINDING_PROPERTY_NOT_JSON",
			`${path}: properties contain a cycle, which has no JSON representation`,
			slot,
		);
	}
	seen.add(value);
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
	if (value === null || !isJsonObject(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function describe(value: JsonValue | undefined): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (isJsonObject(value)) {
		const name: unknown = value.constructor?.name;
		return isJsonString(name) ? `a ${name} instance` : "a non-plain object";
	}
	return `a ${Object.prototype.toString.call(value)}`;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

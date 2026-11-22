import {
	isJsonArray,
	isJsonObject,
	type JsonBag,
	type JsonValue,
} from "../json.js";
import type { EventEnvelope } from "./types.js";

function snapshotOwnProperty(
	copy: JsonValue[] | JsonBag,
	source: JsonValue[] | JsonBag,
	key: string | symbol,
	seen: Set<object>,
): void {
	const descriptor = Object.getOwnPropertyDescriptor(source, key);
	if (!descriptor) return;
	if (!("value" in descriptor)) {
		const accessor: PropertyDescriptor = {
			enumerable: descriptor.enumerable === true,
			configurable: true,
		};
		if (descriptor.get) accessor.get = descriptor.get;
		if (descriptor.set) accessor.set = descriptor.set;
		Object.defineProperty(copy, key, accessor);
		return;
	}
	const value =
		descriptor.value === undefined
			? undefined
			: snapshotJournalData(descriptor.value, seen);
	Object.defineProperty(copy, key, {
		value,
		enumerable: descriptor.enumerable === true,
		writable: true,
		configurable: true,
	});
}

export function snapshotJournalData(
	value: JsonValue,
	seen = new Set<object>(),
): JsonValue {
	if (!isJsonObject(value) && !isJsonArray(value)) return value;
	if (seen.has(value)) throw new Error("cyclic journal data");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const copy: JsonValue[] = [];
			copy.length = value.length;
			for (const name of Object.getOwnPropertyNames(value)) {
				if (name === "length") continue;
				snapshotOwnProperty(copy, value, name, seen);
			}
			for (const symbol of Object.getOwnPropertySymbols(value)) {
				snapshotOwnProperty(copy, value, symbol, seen);
			}
			return copy;
		}
		const copy: JsonBag = {};
		for (const key of Object.getOwnPropertyNames(value)) {
			snapshotOwnProperty(copy, value, key, seen);
		}
		for (const symbol of Object.getOwnPropertySymbols(value)) {
			snapshotOwnProperty(copy, value, symbol, seen);
		}
		return copy;
	} finally {
		seen.delete(value);
	}
}

/** Capture and reject facts returned from a different run's stream. */
export function captureJournalStream(
	events: readonly EventEnvelope[],
	streamId: string,
): EventEnvelope[] {
	const captured = events.map((event): EventEnvelope => {
		const { data, ...envelope } = event;
		return { ...structuredClone(envelope), data: snapshotJournalData(data) };
	});
	for (const event of captured) {
		if (event.streamId !== streamId)
			throw new Error("workflow journal contains a foreign stream");
	}
	return captured;
}

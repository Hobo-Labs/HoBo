/**
 * Parses the body of `POST <controlUrl>/fence` (design §7.3 `Sandbox`): an
 * `ObservedAssignment` as JSON, `origin` as the enum number or its name
 * (`WORK_ORIGIN_FORK`). Anything missing or malformed is undefined, which the
 * control endpoint answers with `{"allow":false}` without asking the fence.
 */
import type { JsonObject, JsonValue } from "@hobo/core";
import {
	type ObservedAssignment,
	type WorkOrigin,
	WorkOriginSchema,
} from "@hobo/fleet";

export function parseObservedAssignment(
	text: string,
): ObservedAssignment | undefined {
	let value: JsonValue;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const { workKey, repository, ref, author } = value;
	const origin = parseOrigin(value.origin);
	if (
		!isText(workKey) ||
		!isText(repository) ||
		!isText(ref) ||
		!isText(author) ||
		origin === undefined
	)
		return undefined;
	return { workKey, repository, ref, author, origin };
}

function parseOrigin(value: JsonValue | undefined): WorkOrigin | undefined {
	const match = WorkOriginSchema.values.find((entry) =>
		isText(value) ? entry.name === value : entry.number === value,
	);
	return match?.number;
}

function isText(value: JsonValue | undefined): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

function isRecord(value: JsonValue): value is JsonObject {
	return Object.prototype.toString.call(value) === "[object Object]";
}

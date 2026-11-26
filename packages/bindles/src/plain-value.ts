/**
 * Plain-JSON traversal helpers shared inside `@hobo/bindles`.
 *
 * eli5: manifests are plain JSON. Two questions come up constantly — "is this a
 * plain object?" and "walk every string in here and tell me where it lives" —
 * and both were previously copy-pasted into three and two files respectively.
 * One copy means one place to fix a traversal bug.
 */

/** True for plain objects — not null, not an array. */
import { isJsonObject, isJsonString, type JsonObject } from "./json.js";

export function isRecord<T>(value: T): value is T & JsonObject {
	return isJsonObject(value) && !Array.isArray(value);
}

/**
 * Depth-first walk of every string in `value`, handing the visitor the string
 * and a dotted/bracketed path to where it was found (`resources.db.url[0]`).
 */
export function visitStrings<T>(
	value: T,
	path: string,
	visitor: (value: string, path: string) => void,
): void {
	if (isJsonString(value)) {
		visitor(value, path);
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			visitStrings(item, `${path}[${index}]`, visitor);
		}
		return;
	}
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) {
			visitStrings(child, `${path}.${key}`, visitor);
		}
	}
}

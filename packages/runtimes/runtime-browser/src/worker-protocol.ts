/**
 * Typed RPC membrane between the UI thread and the SQLite Worker.
 * Implementation-specific SQLite handles never cross this boundary.
 */

import {
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import type { BrowserStorageRequest, BrowserStorageResponse } from "./types.js";

export function parseBrowserStorageRequest(
	value: JsonValue,
): BrowserStorageRequest {
	if (!value || !isJsonObject(value) || Array.isArray(value)) {
		throw new TypeError("storage request must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const source = value as JsonObject;
	if (!isJsonString(source.id) || source.id.length === 0) {
		throw new TypeError("storage request id is required");
	}
	if (!isJsonString(source.op)) {
		throw new TypeError("storage request op is required");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return value as BrowserStorageRequest;
}

export function isBrowserStorageResponse(
	value: JsonValue,
): value is BrowserStorageResponse {
	if (!value || !isJsonObject(value)) return false;
	// SAFETY: assertion required at this I/O or test boundary.
	const source = value as JsonObject;
	return isJsonString(source.id) && isJsonBoolean(source.ok);
}

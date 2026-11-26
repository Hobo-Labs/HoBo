import type { PactRequest, PactResponse } from "@hobo/contract-harness";

import { isJsonObject, type JsonValue } from "../../src/json.js";

/** A pact is parsed JSON: its request and response bodies are JSON values. */
export function jsonBody(
	message: Pick<PactRequest | PactResponse, "body">,
): JsonValue {
	// SAFETY: the harness types a pact body unknown; it was read from a JSON document.
	return (message.body ?? null) as JsonValue;
}

export function fieldOf(value: JsonValue, key: string): JsonValue | undefined {
	return isJsonObject(value) ? value[key] : undefined;
}

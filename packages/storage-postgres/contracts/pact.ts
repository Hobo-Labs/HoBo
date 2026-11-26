import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@hobo/core";
import { isJsonObject, isJsonString, parseJsonText } from "../src/json.js";

/** One interaction of eventstore-boundary.pact.json, parsed. */
export type PactInteraction = Readonly<{
	description: string;
	providerState: string;
	request: JsonObject;
	response: JsonObject;
}>;

export type Pact = Readonly<{
	consumer: string;
	provider: string;
	interactions: readonly PactInteraction[];
}>;

function partyName(document: JsonObject, field: string): string {
	const party = document[field];
	if (!isJsonObject(party) || !isJsonString(party.name)) {
		throw new Error(`pact.${field}.name missing`);
	}
	return party.name;
}

/** Parse the boundary pact; a malformed file fails loudly. */
export function loadPact(): Pact {
	const here = dirname(fileURLToPath(import.meta.url));
	const document = parseJsonText(
		readFileSync(join(here, "eventstore-boundary.pact.json"), "utf8"),
	);
	if (!isJsonObject(document) || !Array.isArray(document.interactions)) {
		throw new Error("eventstore-boundary.pact.json is not a pact");
	}
	const interactions = document.interactions.map((item, index) => {
		if (
			!isJsonObject(item) ||
			!isJsonString(item.description) ||
			!isJsonString(item.providerState) ||
			!isJsonObject(item.request) ||
			!isJsonObject(item.response)
		) {
			throw new Error(`pact interaction ${index} is malformed`);
		}
		return Object.freeze({
			description: item.description,
			providerState: item.providerState,
			request: item.request,
			response: item.response,
		});
	});
	return Object.freeze({
		consumer: partyName(document, "consumer"),
		provider: partyName(document, "provider"),
		interactions,
	});
}

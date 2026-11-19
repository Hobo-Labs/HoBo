import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../src/json.js";

export interface AvailabilityInteraction {
	readonly description: string;
	readonly request: JsonValue;
	readonly response: JsonValue;
}

export const availabilityPactPath = fileURLToPath(
	new URL("./pacts/availability-view.pact.json", import.meta.url),
);

function object(value: JsonValue | undefined): JsonObject {
	if (!isJsonObject(value))
		throw new Error("availability pact value must be an object");
	return value;
}

function content(value: JsonValue | undefined): JsonValue {
	const envelope = object(object(value).contents);
	if (
		envelope.contentType !== "application/json" ||
		envelope.content === undefined
	) {
		throw new Error("availability pact content must be JSON");
	}
	return envelope.content;
}

export function availabilityInteractions(): readonly AvailabilityInteraction[] {
	const pact = object(
		parseJsonValue(readFileSync(availabilityPactPath, "utf8")),
	);
	if (!Array.isArray(pact.interactions) || pact.interactions.length === 0) {
		throw new Error("availability pact must contain interactions");
	}
	return pact.interactions.map((entry) => {
		const interaction = object(entry);
		if (
			interaction.type !== "Synchronous/Messages" ||
			!isJsonString(interaction.description) ||
			!Array.isArray(interaction.response) ||
			interaction.response.length !== 1
		) {
			throw new Error("availability pact interaction is malformed");
		}
		return {
			description: interaction.description,
			request: content(interaction.request),
			response: content(interaction.response[0]),
		};
	});
}

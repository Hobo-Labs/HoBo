import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "../src/json.js";
import { parseBetterAuthConfig } from "../src/index.js";

type PactInteractionCase = {
	readonly description: string;
	readonly configBody: JsonObject;
	readonly expectedContract: string;
	readonly expectedAdapterId: string;
	readonly expectedBasePath: string;
};

function parsePactInteractions(text: string): readonly PactInteractionCase[] {
	const root = parseJsonValue(text);
	if (!isJsonObject(root)) {
		throw new Error("pact must be a JSON object");
	}
	const interactions = root.interactions;
	if (!isJsonArray(interactions)) {
		throw new Error("pact interactions must be an array");
	}
	const cases: PactInteractionCase[] = [];
	for (const entry of interactions) {
		if (!isJsonObject(entry)) continue;
		const description = entry.description;
		if (!isJsonString(description)) continue;
		const request = entry.request;
		if (!isJsonObject(request)) continue;
		const body = request.body;
		if (!isJsonObject(body)) continue;
		const response = entry.response;
		if (!isJsonObject(response)) continue;
		const responseBody = response.body;
		if (!isJsonObject(responseBody)) continue;
		const expectedContract = responseBody.contract;
		const expectedAdapterId = responseBody.adapterId;
		const expectedBasePath = responseBody.basePath;
		if (
			!isJsonString(expectedContract) ||
			!isJsonString(expectedAdapterId) ||
			!isJsonString(expectedBasePath)
		) {
			continue;
		}
		cases.push({
			description,
			configBody: body,
			expectedContract,
			expectedAdapterId,
			expectedBasePath,
		});
	}
	return Object.freeze(cases);
}

const pactFile = join(
	dirname(fileURLToPath(import.meta.url)),
	"../contracts/pacts/auth-adapter-config-boundary.pact.json",
);
const interactions = parsePactInteractions(readFileSync(pactFile, "utf8"));

describe("auth-adapter-config boundary pact", () => {
	for (const interaction of interactions) {
		it(interaction.description, () => {
			const config = parseBetterAuthConfig(interaction.configBody);
			expect(config.contract).toBe(interaction.expectedContract);
			expect(config.adapterId).toBe(interaction.expectedAdapterId);
			expect(config.basePath).toBe(interaction.expectedBasePath);
		});
	}
});
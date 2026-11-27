import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseBetterAuthConfig } from "../src/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "../src/json.js";

type PactInteractionCase = {
	readonly description: string;
	readonly configBody: JsonObject;
	readonly expectedContract: string;
	readonly expectedAdapterId: string;
	readonly expectedBasePath: string;
};

function malformed(detail: string): never {
	throw new Error(`malformed pact interaction: ${detail}`);
}

function parsePactInteractions(text: string): readonly PactInteractionCase[] {
	const root = parseJsonValue(text);
	if (!isJsonObject(root)) throw new Error("pact must be a JSON object");
	const interactions = root.interactions;
	if (!isJsonArray(interactions))
		throw new Error("interactions must be an array");
	const cases: PactInteractionCase[] = [];
	for (const entry of interactions) {
		if (!isJsonObject(entry)) malformed("interaction must be an object");
		const description = entry.description;
		const request = entry.request;
		const response = entry.response;
		if (
			!isJsonString(description) ||
			!isJsonObject(request) ||
			!isJsonObject(response)
		) {
			malformed("interaction is missing description, request, or response");
		}
		const body = request.body;
		const responseBody = response.body;
		if (!isJsonObject(body) || !isJsonObject(responseBody)) {
			malformed("interaction body is missing");
		}
		const expectedContract = responseBody.contract;
		const expectedAdapterId = responseBody.adapterId;
		const expectedBasePath = responseBody.basePath;
		if (
			!isJsonString(expectedContract) ||
			!isJsonString(expectedAdapterId) ||
			!isJsonString(expectedBasePath)
		) {
			malformed("success response is missing contract fields");
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
const cases = parsePactInteractions(readFileSync(pactFile, "utf8"));

describe("auth-adapter-config boundary pact", () => {
	it("loads every interaction from the pact file", () => {
		const root = parseJsonValue(readFileSync(pactFile, "utf8"));
		if (!isJsonObject(root) || !isJsonArray(root.interactions)) {
			throw new Error("pact interactions missing");
		}
		const { interactions } = root;
		expect(interactions.length).toBe(1);
		expect(cases.length).toBe(interactions.length);
	});

	it("throws on a malformed interaction", () => {
		expect(() =>
			parsePactInteractions(
				JSON.stringify({
					interactions: [{ description: "broken" }],
				}),
			),
		).toThrow(/malformed pact interaction/u);
	});

	for (const interaction of cases) {
		it(interaction.description, () => {
			const config = parseBetterAuthConfig(interaction.configBody);
			expect(config.contract).toBe(interaction.expectedContract);
			expect(config.adapterId).toBe(interaction.expectedAdapterId);
			expect(config.basePath).toBe(interaction.expectedBasePath);
		});
	}
});

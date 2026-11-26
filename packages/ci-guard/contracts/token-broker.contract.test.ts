import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonTree,
} from "../src/json.js";

const pactDir = path.dirname(fileURLToPath(import.meta.url));

interface TokenBrokerPact {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly TokenBrokerInteraction[];
}

interface TokenBrokerInteraction {
	readonly request: { readonly body: TokenBrokerRequestBody };
	readonly response: { readonly body: TokenBrokerResponseBody };
}

interface TokenBrokerRequestBody {
	readonly audience: string;
	readonly role: string;
}

interface TokenBrokerResponseBody {
	readonly allowedActions: readonly string[];
	readonly role: string;
}

function objectField(parent: JsonObject, key: string): JsonObject {
	const value = parent[key];
	if (!isJsonObject(value)) {
		throw new Error(`pact field ${key} must be an object`);
	}
	return value;
}

function stringField(parent: JsonObject, key: string): string {
	const value = parent[key];
	if (!isJsonString(value)) {
		throw new Error(`pact field ${key} must be a string`);
	}
	return value;
}

function stringArrayField(parent: JsonObject, key: string): readonly string[] {
	const value = parent[key];
	if (!Array.isArray(value) || !value.every((item) => isJsonString(item))) {
		throw new Error(`pact field ${key} must be a string array`);
	}
	return value;
}

function parseInteraction(value: JsonValue): TokenBrokerInteraction {
	if (!isJsonObject(value)) {
		throw new Error("pact interaction must be an object");
	}
	const requestBody = objectField(objectField(value, "request"), "body");
	const responseBody = objectField(objectField(value, "response"), "body");
	return {
		request: {
			body: {
				audience: stringField(requestBody, "audience"),
				role: stringField(requestBody, "role"),
			},
		},
		response: {
			body: {
				role: stringField(responseBody, "role"),
				allowedActions: stringArrayField(responseBody, "allowedActions"),
			},
		},
	};
}

function parseTokenBrokerPact(raw: string): TokenBrokerPact {
	const parsed = parseJsonTree(raw);
	if (!isJsonObject(parsed)) {
		throw new Error("pact document must be an object");
	}
	const interactions = parsed.interactions;
	if (!Array.isArray(interactions)) {
		throw new Error("pact interactions must be an array");
	}
	return {
		consumer: { name: stringField(objectField(parsed, "consumer"), "name") },
		provider: { name: stringField(objectField(parsed, "provider"), "name") },
		interactions: interactions.map(parseInteraction),
	};
}

describe("token-broker consumer pact", () => {
	it("pins @hobo/ci-guard → hobo-oidc-token-broker token exchange", async () => {
		const pactPath = path.join(
			pactDir,
			"pacts",
			"ci-guard-token-broker.pact.json",
		);
		const raw = await readFile(pactPath, "utf8");
		const pact = parseTokenBrokerPact(raw);

		expect(pact.consumer.name).toBe("@hobo/ci-guard");
		expect(pact.provider.name).toBe("hobo-oidc-token-broker");

		const interaction = pact.interactions[0];
		expect(interaction?.request.body.audience).toBe("hobo:sandbox-cloud");
		expect(interaction?.request.body.role).toBe("hobo-ci-hello-bindle-e2e");
		expect(interaction?.response.body.role).toBe("hobo-ci-hello-bindle-e2e");
		expect(interaction?.response.body.allowedActions).toEqual([
			"deployments:create",
			"deployments:read",
			"deployments:delete",
		]);
	});
});

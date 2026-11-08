/**
 * The catalog pact, replayed against the real exports.
 *
 * The boundary is in-process — a composition reading definitions — so the
 * pact's "responses" are computed here from `LOCAL_DEFINITIONS` and
 * `LOCAL_ENGINE_GAPS` and compared with the recorded bodies. A drift
 * between what this package publishes and what the pact promises fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	LOCAL_DEFINITIONS,
	LOCAL_ENGINE_GAPS,
	LOCAL_PROVIDER_ID,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

type PactInteraction = {
	readonly description: string;
	readonly request: { readonly method: string; readonly path: string };
	readonly response: { readonly status: number; readonly body: JsonValue };
};

type PactFile = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly PactInteraction[];
};

function parseInteraction(entry: JsonObject): PactInteraction {
	const request = isJsonObject(entry.request) ? entry.request : undefined;
	const response = isJsonObject(entry.response) ? entry.response : undefined;
	if (
		!isJsonString(entry.description) ||
		request === undefined ||
		response === undefined ||
		!isJsonString(request.method) ||
		!isJsonString(request.path) ||
		!isJsonNumber(response.status) ||
		response.body === undefined
	) {
		throw new Error("the pact file has a malformed interaction");
	}
	return {
		description: entry.description,
		request: { method: request.method, path: request.path },
		response: { status: response.status, body: response.body },
	};
}

/** Parse the pact rather than trusting its shape. */
function loadPact(): PactFile {
	const decoded = parseJsonObject(
		readFileSync(
			fileURLToPath(
				new URL(
					"../contracts/provider-local-catalog.pact.json",
					import.meta.url,
				),
			),
			"utf8",
		),
	);
	const consumer = isJsonObject(decoded.consumer) ? decoded.consumer : undefined;
	const provider = isJsonObject(decoded.provider) ? decoded.provider : undefined;
	const interactionsRaw = decoded.interactions;
	if (
		!isJsonString(consumer?.name) ||
		!isJsonString(provider?.name) ||
		!isJsonArray(interactionsRaw) ||
		interactionsRaw.length === 0
	) {
		throw new Error("the pact file is malformed");
	}
	const interactions: PactInteraction[] = [];
	for (const entry of interactionsRaw) {
		if (!isJsonObject(entry)) {
			throw new Error("the pact file has a malformed interaction");
		}
		interactions.push(parseInteraction(entry));
	}
	return {
		consumer: { name: consumer.name },
		provider: { name: provider.name },
		interactions,
	};
}

const pact = loadPact();

function actualFor(path: string): JsonObject {
	if (path === "/provider-local/definitions") {
		return {
			providerId: LOCAL_PROVIDER_ID,
			definitions: LOCAL_DEFINITIONS.map((definition) => ({
				id: definition.id,
				productId: definition.semantics.productId,
				profiles: definition.semantics.implementsProfiles
					.map((implementation) => implementation.profileId)
					.sort(),
			})),
		};
	}
	if (path.startsWith("/provider-local/definitions?profile=")) {
		const profile = path.slice("/provider-local/definitions?profile=".length);
		return {
			providerId: LOCAL_PROVIDER_ID,
			profile,
			definitionIds: LOCAL_DEFINITIONS.filter((definition) =>
				definition.semantics.implementsProfiles.some(
					(implementation) => implementation.profileId === profile,
				),
			).map((definition) => definition.id),
		};
	}
	if (path === "/provider-local/gaps") {
		return {
			providerId: LOCAL_PROVIDER_ID,
			gapProductIds: LOCAL_ENGINE_GAPS.map((gap) => gap.productId).sort(),
		};
	}
	const evidence = /^\/provider-local\/definitions\/(.+)\/evidence$/u.exec(path);
	if (evidence?.[1] !== undefined) {
		const definition = LOCAL_DEFINITIONS.find(
			(candidate) => candidate.id === evidence[1],
		);
		if (definition === undefined) throw new Error(`unknown id ${evidence[1]}`);
		return {
			id: definition.id,
			evidenceSignatureValid: definition.semantics.evidenceSignatureValid,
			conformance: definition.semantics.implementsProfiles.map(
				(implementation) => implementation.conformance,
			),
		};
	}
	throw new Error(`unhandled pact path ${path}`);
}

describe("provider-local-catalog.pact.json", () => {
	it("names this package as provider", () => {
		expect(pact.provider.name).toBe("@hobo/provider-local");
		expect(pact.interactions.length).toBeGreaterThan(0);
	});

	it("replays every interaction against the real exports", () => {
		for (const interaction of pact.interactions) {
			expect(
				actualFor(interaction.request.path),
				interaction.description,
			).toEqual(interaction.response.body);
		}
	});
});

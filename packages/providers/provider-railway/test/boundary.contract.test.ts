/**
 * Consumer-driven contract verification for the yard boundary.
 *
 * `contracts/provider-railway-yard-boundary.pact.json` states what the yard
 * placement plane expects of this package. A pact nobody replays is a wish, so
 * this suite loads the file and drives the *real* `createRailwayProvider()`
 * through every interaction it records.
 *
 * There is no transport to fake. This provider makes no network call from
 * `src/`: its boundary is in-process, the interactions are messages, and the
 * only seam is the refusal that stands in for a temporary Environment Station
 * Railway does not offer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
	createRailwayProvider,
	provisionTemporaryEnvironmentStation,
	RAILWAY_REJECTED_CODE,
	RailwayInputRejectedError,
	TemporaryProvisionUnavailableError,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
} from "../src/json.js";

type PactMessage = {
	readonly description: string;
	readonly request: {
		readonly type: string;
		readonly body: JsonObject;
	};
	readonly response: { readonly body: JsonObject };
};

type PactFile = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly PactMessage[];
};

/**
 * Parse the pact rather than trusting its shape: a suite that reads
 * `interactions[3].response.body` off an `unknown` fails three assertions
 * later with a property error instead of saying the pact is malformed.
 */
function loadPact(): PactFile {
	const decoded = parseJsonObject(
		readFileSync(
			fileURLToPath(
				new URL(
					"../contracts/provider-railway-yard-boundary.pact.json",
					import.meta.url,
				),
			),
			"utf8",
		),
	);
	const interactionsRaw = decoded.interactions;
	if (!isJsonArray(interactionsRaw) || interactionsRaw.length === 0) {
		throw new Error("the pact file declares no interactions");
	}
	const consumer = isJsonObject(decoded.consumer)
		? decoded.consumer
		: undefined;
	const provider = isJsonObject(decoded.provider)
		? decoded.provider
		: undefined;
	if (!isJsonString(consumer?.name) || !isJsonString(provider?.name)) {
		throw new Error("the pact file is missing its consumer or provider name");
	}
	const interactions: PactMessage[] = [];
	for (const entry of interactionsRaw) {
		if (!isJsonObject(entry) || !isJsonString(entry.description)) {
			throw new Error("the pact file has a malformed interaction");
		}
		const request = isJsonObject(entry.request) ? entry.request : undefined;
		const response = isJsonObject(entry.response) ? entry.response : undefined;
		const requestBody = isJsonObject(request?.body) ? request.body : undefined;
		const responseBody = isJsonObject(response?.body)
			? response.body
			: undefined;
		if (
			requestBody === undefined ||
			responseBody === undefined ||
			!isJsonString(request?.type)
		) {
			throw new Error("the pact file has a malformed interaction");
		}
		interactions.push({
			description: entry.description,
			request: { type: request.type, body: requestBody },
			response: { body: responseBody },
		});
	}
	return {
		consumer: { name: consumer.name },
		provider: { name: provider.name },
		interactions,
	};
}

const pact = loadPact();

function interaction(fragment: string): PactMessage {
	const found = pact.interactions.find((entry) =>
		entry.description.includes(fragment),
	);
	if (found === undefined) {
		throw new Error(
			`the pact has no interaction matching ${JSON.stringify(fragment)}`,
		);
	}
	return found;
}

function requestBody(fragment: string): JsonObject {
	return interaction(fragment).request.body;
}

function responseBody(fragment: string): JsonObject {
	return interaction(fragment).response.body;
}

function jsonString(value: JsonObject[string] | undefined): string {
	return isJsonString(value) ? value : "";
}

function jsonStringMap(value: JsonObject[string] | undefined) {
	if (!isJsonObject(value)) return {};
	const mapped: { [key: string]: string } = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isJsonString(entry)) mapped[key] = entry;
	}
	return mapped;
}

/** Every recorded rejection carries the same code and names the offending field. */
function expectRejection(fragment: string, run: () => void): void {
	const expected = responseBody(fragment).error;
	const expectedError = isJsonObject(expected) ? expected : {};
	expect(expectedError.code).toBe(RAILWAY_REJECTED_CODE);
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(RailwayInputRejectedError);
		if (!(error instanceof RailwayInputRejectedError)) return;
		expect(error.code).toBe(expectedError.code);
		expect(error.field).toBe(expectedError.field);
		return;
	}
	throw new Error(`${fragment} was expected to be rejected and was not`);
}

describe("the pact file itself", () => {
	it("names the yard boundary it describes", () => {
		expect(pact.consumer.name).toBe("hobo-yard-placement-plane");
		expect(pact.provider.name).toBe("ProviderRailwayYardBoundary");
		expect(
			pact.interactions.every((entry) => entry.request.type === "message"),
		).toBe(true);
	});
});

describe("descriptor and manifest, verified against the pact", () => {
	it("describes itself as the pact records", () => {
		const provider = createRailwayProvider();
		const expected = responseBody("describe the provider");

		expect(provider.id).toBe(expected.id);
		expect(provider.regions).toEqual(expected.regions);
		expect(provider.capabilities.map((capability) => capability.port)).toEqual(
			expected.ports,
		);
	});

	it("publishes the manifest the pact records, field for field", () => {
		const manifest = createRailwayProvider().capabilityManifest();

		expect(JSON.parse(JSON.stringify(manifest))).toEqual(
			responseBody("publish the capability manifest"),
		);
	});
});

describe("matching answers, verified against the pact", () => {
	function satisfiesFor(fragment: string) {
		const request = requestBody(fragment);
		const provider = createRailwayProvider();
		const capability = provider.capabilities.find(
			(entry) => entry.port === jsonString(request.port),
		);
		// A port Railway does not realize has no capability object at all, and
		// the plane must still get "none" rather than an absent answer.
		const features = isJsonArray(request.features)
			? request.features.filter(isJsonString)
			: undefined;
		return (
			capability?.satisfies({
				port: jsonString(request.port),
				...(features === undefined ? undefined : { features }),
			}) ?? { kind: "none" as const }
		);
	}

	it("reports a full match when every requested feature is carried", () => {
		expect(
			satisfiesFor("whose features the equivalence class carries"),
		).toEqual(responseBody("whose features the equivalence class carries"));
	});

	it("names the missing feature on a partial match", () => {
		expect(satisfiesFor("a feature Railway does not carry")).toEqual(
			responseBody("a feature Railway does not carry"),
		);
	});

	it("reports none for a port that is not in the equivalence table", () => {
		expect(satisfiesFor("a port Railway does not realize")).toEqual(
			responseBody("a port Railway does not realize"),
		);
	});

	it("estimates cost as the unpriced signal the pact records", () => {
		const request = requestBody("estimate cost");
		const capability = createRailwayProvider().capabilities.find(
			(entry) => entry.port === jsonString(request.port),
		);

		expect(
			capability?.estimateCost({ port: jsonString(request.port) }),
		).toEqual(responseBody("estimate cost"));
	});
});

describe("realize, verified against the pact", () => {
	it("emits the one-resource driver program the pact records", () => {
		const request = requestBody("realize a kv plan");
		const realized = createRailwayProvider().realize({
			name: jsonString(
				isJsonObject(request.plan) ? request.plan.name : undefined,
			),
			port: jsonString(
				isJsonObject(request.plan) ? request.plan.port : undefined,
			),
		});

		expect(JSON.parse(JSON.stringify(realized))).toEqual(
			responseBody("realize a kv plan"),
		);
	});

	it("rejects an unrealizable port at the parser", () => {
		const request = requestBody("reject a plan whose port");
		expectRejection("reject a plan whose port", () => {
			createRailwayProvider().realize({
				name: jsonString(
					isJsonObject(request.plan) ? request.plan.name : undefined,
				),
				port: jsonString(
					isJsonObject(request.plan) ? request.plan.port : undefined,
				),
			});
		});
	});

	it("rejects a plan name that could not become a DNS label", () => {
		const request = requestBody("reject a plan name");
		expectRejection("reject a plan name", () => {
			createRailwayProvider().realize({
				name: jsonString(
					isJsonObject(request.plan) ? request.plan.name : undefined,
				),
				port: jsonString(
					isJsonObject(request.plan) ? request.plan.port : undefined,
				),
			});
		});
	});
});

describe("client bindings, verified against the pact", () => {
	it("returns the resolved class plus the deploy outputs the pact records", () => {
		const request = requestBody("bind deploy outputs");
		const client = createRailwayProvider().client(
			jsonString(request.port),
			jsonStringMap(request.outputs),
		);

		expect(JSON.parse(JSON.stringify(client))).toEqual(
			responseBody("bind deploy outputs"),
		);
	});

	it("rejects a binding value carrying a second line", () => {
		const request = requestBody("reject a deploy output");
		expectRejection("reject a deploy output", () => {
			createRailwayProvider().client(
				jsonString(request.port),
				jsonStringMap(request.outputs),
			);
		});
	});
});

describe("temporary Environment Station, verified against the pact", () => {
	it("refuses with the recorded refusal instead of provisioning anything", async () => {
		const request = requestBody("refuse a temporary Environment Station");
		const expected = responseBody("refuse a temporary Environment Station");

		await expect(
			provisionTemporaryEnvironmentStation({
				stationId: jsonString(request.stationId),
			}),
		).rejects.toSatisfy((error: Error) => {
			if (!(error instanceof TemporaryProvisionUnavailableError)) return false;
			const { providerId, code, supportsAnonymousTemporaryDeploy } =
				error.refusal;
			return (
				providerId === expected.providerId &&
				code === expected.code &&
				supportsAnonymousTemporaryDeploy ===
					expected.supportsAnonymousTemporaryDeploy
			);
		});
	});
});

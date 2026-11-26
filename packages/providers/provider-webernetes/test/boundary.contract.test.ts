/**
 * Consumer-driven contract verification for the yard boundary.
 *
 * `contracts/provider-webernetes-yard-boundary.pact.json` states what the yard
 * placement plane expects of this package. A pact nobody replays is a wish, so
 * this suite loads the file and drives the *real* `createWebernetesProvider()`
 * through every interaction it records. Nothing is stubbed: this half of the
 * package has no seam, because it makes no call out.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
	createWebernetesProvider,
	WEBERNETES_REJECTED_CODE,
	WebernetesInputRejectedError,
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

function loadPact(): PactFile {
	const decoded = parseJsonObject(
		readFileSync(
			fileURLToPath(
				new URL(
					"../contracts/provider-webernetes-yard-boundary.pact.json",
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
		const reqBody = isJsonObject(request?.body) ? request.body : undefined;
		const resBody = isJsonObject(response?.body) ? response.body : undefined;
		if (
			reqBody === undefined ||
			resBody === undefined ||
			!isJsonString(request?.type)
		) {
			throw new Error("the pact file has a malformed interaction");
		}
		interactions.push({
			description: entry.description,
			request: { type: request.type, body: reqBody },
			response: { body: resBody },
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

function expectRejection(fragment: string, run: () => void): void {
	const expected = responseBody(fragment).error;
	const expectedError = isJsonObject(expected) ? expected : {};
	expect(expectedError.code).toBe(WEBERNETES_REJECTED_CODE);
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(WebernetesInputRejectedError);
		if (!(error instanceof WebernetesInputRejectedError)) return;
		expect(error.code).toBe(expectedError.code);
		expect(error.field).toBe(expectedError.field);
		return;
	}
	throw new Error(`${fragment} was expected to be rejected and was not`);
}

describe("the pact file itself", () => {
	it("names the yard boundary it describes", () => {
		expect(pact.consumer.name).toBe("hobo-yard-placement-plane");
		expect(pact.provider.name).toBe("ProviderWebernetesYardBoundary");
		expect(
			pact.interactions.every((entry) => entry.request.type === "message"),
		).toBe(true);
	});
});

describe("descriptor and manifest, verified against the pact", () => {
	it("describes itself as the pact records", () => {
		const provider = createWebernetesProvider();
		const expected = responseBody("describe the provider");

		expect(provider.id).toBe(expected.id);
		expect(provider.regions).toEqual(expected.regions);
		expect(provider.capabilities.map((capability) => capability.port)).toEqual(
			expected.ports,
		);
	});

	it("publishes the manifest the pact records, field for field", () => {
		const manifest = createWebernetesProvider().capabilityManifest();

		expect(JSON.parse(JSON.stringify(manifest))).toEqual(
			responseBody("publish the capability manifest"),
		);
	});
});

describe("matching answers, verified against the pact", () => {
	function satisfiesFor(fragment: string) {
		const request = requestBody(fragment);
		const capability = createWebernetesProvider().capabilities.find(
			(entry) => entry.port === jsonString(request.port),
		);
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
		expect(satisfiesFor("whose features the local pod carries")).toEqual(
			responseBody("whose features the local pod carries"),
		);
	});

	it("will not claim managed compute", () => {
		expect(satisfiesFor("refuse to claim managed compute")).toEqual(
			responseBody("refuse to claim managed compute"),
		);
	});

	it("reports none for a port the local yard does not host", () => {
		expect(satisfiesFor("a port the local yard does not host")).toEqual(
			responseBody("a port the local yard does not host"),
		);
	});

	it("estimates cost as the recorded zero", () => {
		const request = requestBody("estimate cost");
		const capability = createWebernetesProvider().capabilities.find(
			(entry) => entry.port === jsonString(request.port),
		);

		expect(
			capability?.estimateCost({ port: jsonString(request.port) }),
		).toEqual(responseBody("estimate cost"));
	});
});

describe("realize, verified against the pact", () => {
	it("emits the one-resource driver program the pact records", () => {
		const request = requestBody("realize a compute plan");
		const realized = createWebernetesProvider().realize({
			name: jsonString(
				isJsonObject(request.plan) ? request.plan.name : undefined,
			),
			port: jsonString(
				isJsonObject(request.plan) ? request.plan.port : undefined,
			),
		});

		expect(JSON.parse(JSON.stringify(realized))).toEqual(
			responseBody("realize a compute plan"),
		);
	});

	it("rejects a port the local yard cannot host", () => {
		const request = requestBody("reject a plan whose port");
		expectRejection("reject a plan whose port", () => {
			createWebernetesProvider().realize({
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
			createWebernetesProvider().realize({
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
		const client = createWebernetesProvider().client(
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
			createWebernetesProvider().client(
				jsonString(request.port),
				jsonStringMap(request.outputs),
			);
		});
	});
});

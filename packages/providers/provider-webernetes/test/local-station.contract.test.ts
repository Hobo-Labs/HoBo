/**
 * Consumer-driven contract verification for the local station boundary.
 *
 * `contracts/provider-webernetes-local-station.pact.json` records what this
 * package expects a local station host to hand back through
 * `LocalTempTransport`. That transport is the only seam here, so it is the only
 * thing faked: each interaction's recorded reply is served through a stub
 * transport and the *real* `provisionTemporaryEnvironmentStation()` runs
 * against it.
 *
 * Three of the recorded replies are refusals. They are in the pact because the
 * interesting property of this boundary is not that a station comes back — it
 * is that a station which is not local, or whose URL carries a credential,
 * does not.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
	type LocalTempTransport,
	parseWebernetesLocalEndpoint,
	provisionTemporaryEnvironmentStation,
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
	readonly response: {
		readonly body: { readonly stationUrl: string; readonly claimUrl: string };
	};
	readonly providerStates?: readonly { readonly name: string }[];
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
					"../contracts/provider-webernetes-local-station.pact.json",
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
			!isJsonString(request?.type) ||
			!isJsonString(resBody.stationUrl) ||
			!isJsonString(resBody.claimUrl)
		) {
			throw new Error("the pact file has a malformed interaction");
		}
		const providerStates: { name: string }[] = [];
		if (isJsonArray(entry.providerStates)) {
			for (const state of entry.providerStates) {
				if (isJsonObject(state) && isJsonString(state.name)) {
					providerStates.push({ name: state.name });
				}
			}
		}
		interactions.push({
			description: entry.description,
			request: { type: request.type, body: reqBody },
			response: {
				body: { stationUrl: resBody.stationUrl, claimUrl: resBody.claimUrl },
			},
			...(providerStates.length > 0 ? { providerStates } : undefined),
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

/** The seam: one recorded reply, and a record of what was asked for. */
function transportFor(
	entry: PactMessage,
): LocalTempTransport & { readonly requests: readonly string[] } {
	const requests: string[] = [];
	return {
		requests,
		async provision({ stationId }) {
			requests.push(stationId);
			return { ...entry.response.body };
		},
	};
}

function stationIdOf(entry: PactMessage): string {
	return isJsonString(entry.request.body.stationId)
		? entry.request.body.stationId
		: "";
}

describe("the pact file itself", () => {
	it("names the seam it describes", () => {
		expect(pact.consumer.name).toBe("@hobo/provider-webernetes");
		expect(pact.provider.name).toBe("WebernetesLocalStationHost");
		expect(
			pact.interactions.every((entry) => entry.request.type === "message"),
		).toBe(true);
	});

	it("carries no credential in any recorded reply except the one it exists to refuse", () => {
		const withUserinfo = pact.interactions.filter((entry) =>
			entry.response.body.stationUrl.includes("@"),
		);
		expect(withUserinfo).toHaveLength(1);
		expect(withUserinfo[0]?.description).toContain("userinfo");
		expect(withUserinfo[0]?.response.body.stationUrl).toContain("REDACTED");
	});
});

describe("the configured local transport, verified against the pact", () => {
	it("accepts the .hobo.localhost pair only when a host transport supplies it", async () => {
		const entry = interaction("names a .hobo.localhost host");

		await expect(
			provisionTemporaryEnvironmentStation({ stationId: stationIdOf(entry) }),
		).rejects.toThrow("real local station host transport");
		const result = await provisionTemporaryEnvironmentStation({
			stationId: stationIdOf(entry),
			transport: transportFor(entry),
		});

		expect(result.stationUrl).toBe(entry.response.body.stationUrl);
		expect(result.claimUrl).toBe(entry.response.body.claimUrl);
	});
});

describe("station replies the host may produce, verified against the pact", () => {
	for (const fragment of [
		"answers same-origin on loopback",
		"bound to a LAN address",
	]) {
		it(`accepts the reply that ${fragment}`, async () => {
			const entry = interaction(fragment);
			const transport = transportFor(entry);

			const result = await provisionTemporaryEnvironmentStation({
				stationId: stationIdOf(entry),
				transport,
			});

			expect(transport.requests).toEqual([stationIdOf(entry)]);
			expect(result.stationUrl).toBe(entry.response.body.stationUrl);
			expect(result.primaryUrl).toBe(entry.response.body.stationUrl);
			expect(result.claimUrl).toBe(entry.response.body.claimUrl);
			expect(result.providerId).toBe("webernetes");
			expect(result.anonymous).toBe(true);
			expect(result.temporary).toBe(true);
			// The lease is finite, which is the other half of "temporary".
			expect(result.ttlSeconds).toBeGreaterThan(0);
			expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
		});
	}
});

describe("station replies the host must not produce, verified against the pact", () => {
	for (const fragment of [
		"points at a public host",
		"carries userinfo",
		"bare .hobo station name",
	]) {
		it(`refuses the reply that ${fragment}`, async () => {
			const entry = interaction(fragment);

			await expect(
				provisionTemporaryEnvironmentStation({
					stationId: stationIdOf(entry),
					transport: transportFor(entry),
				}),
			).rejects.toSatisfy(
				(error: Error) =>
					error instanceof WebernetesInputRejectedError &&
					error.code === WEBERNETES_REJECTED_CODE &&
					error.field === "stationUrl",
			);
		});
	}

	it("records why each refusal exists", () => {
		for (const fragment of [
			"points at a public host",
			"carries userinfo",
			"bare .hobo station name",
		]) {
			expect(interaction(fragment).providerStates?.[0]?.name).toBeTruthy();
		}
	});
});

describe("the endpoint parser behind those refusals", () => {
	it("classifies each accepted host by where it actually lives", () => {
		expect(
			parseWebernetesLocalEndpoint(
				"https://demo.webernetes.hobo.localhost",
				"stationUrl",
			).locality,
		).toBe("loopback");
		expect(
			parseWebernetesLocalEndpoint("http://192.168.1.20:4321/", "stationUrl")
				.locality,
		).toBe("private-network");
		expect(
			parseWebernetesLocalEndpoint("https://demo.hobo.test/", "stationUrl")
				.locality,
		).toBe("overlay");
	});

	it("lowercases the host it reports, so no caller re-normalizes one", () => {
		expect(
			parseWebernetesLocalEndpoint("https://Demo.HOBO.test/", "stationUrl")
				.host,
		).toBe("demo.hobo.test");
	});
});

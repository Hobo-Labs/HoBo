import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	type ArcRunnerSetClient,
	createArcRunnerSetClient,
	KubernetesProviderError,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../src/json.js";

const API_SERVER_URL = "https://arc.cluster.example.test:6443";
const TOKEN = "synthetic-arc-bearer-token-0123456789abcdef";

type Interaction = Readonly<{
	description: string;
	method: string;
	path: string;
	query: string;
	headers: JsonObject;
	body: JsonValue | undefined;
	status: number;
	responseBody: JsonValue;
}>;

function objectAt(value: JsonValue | undefined, what: string): JsonObject {
	if (!isJsonObject(value))
		throw new Error(`the pact's ${what} is not an object`);
	return value;
}

function stringAt(value: JsonValue | undefined, what: string): string {
	if (!isJsonString(value))
		throw new Error(`the pact's ${what} is not a string`);
	return value;
}

function parseInteraction(value: JsonValue): Interaction {
	const entry = objectAt(value, "interaction");
	const request = objectAt(entry.request, "request");
	const response = objectAt(entry.response, "response");
	const status = response.status;
	if (!isJsonNumber(status))
		throw new Error("the pact's status is not a number");
	return {
		description: stringAt(entry.description, "description"),
		method: stringAt(request.method, "method"),
		path: stringAt(request.path, "path"),
		query: request.query === undefined ? "" : stringAt(request.query, "query"),
		headers:
			request.headers === undefined ? {} : objectAt(request.headers, "headers"),
		body: request.body,
		status,
		responseBody: response.body ?? null,
	};
}

const document = objectAt(
	parseJsonValue(
		readFileSync(
			fileURLToPath(
				new URL(
					"../contracts/provider-kubernetes-arc-runner-sets.pact.json",
					import.meta.url,
				),
			),
			"utf8",
		),
	),
	"document",
);
const source = objectAt(
	objectAt(document.metadata, "metadata").source,
	"source",
);
const interactions = isJsonArray(document.interactions)
	? document.interactions.map(parseInteraction)
	: [];

function interaction(fragment: string): Interaction {
	const found = interactions.find((entry) =>
		entry.description.includes(fragment),
	);
	if (found === undefined) throw new Error(`no interaction ${fragment}`);
	return found;
}

function replaying(entry: Interaction) {
	const requests: TransportRequest[] = [];
	const transport: HttpTransport = async (request) => {
		requests.push(request);
		const response: TransportResponse = {
			status: entry.status,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(entry.responseBody),
		};
		return response;
	};
	return {
		requests,
		client: createArcRunnerSetClient({
			transport,
			apiServerUrl: API_SERVER_URL,
			bearerToken: TOKEN,
		}),
	};
}

function objectBody(entry: Interaction): JsonObject {
	return objectAt(entry.body, `${entry.description} body`);
}

function arrayBody(entry: Interaction): JsonValue[] {
	if (!isJsonArray(entry.body))
		throw new Error(`${entry.description} carries no array body`);
	return entry.body;
}

function sent(requests: readonly TransportRequest[], entry: Interaction): void {
	expect(requests).toHaveLength(1);
	const [request] = requests;
	if (request === undefined) throw new Error("no request was sent");
	const url = new URL(request.url);
	expect(request.method).toBe(entry.method);
	expect(url.pathname).toBe(entry.path);
	expect(url.search.replace(/^\?/u, "")).toBe(entry.query);
	for (const [name, value] of Object.entries(entry.headers))
		expect(request.headers[name]).toBe(value);
	expect(request.headers.Authorization).toBe(`Bearer ${TOKEN}`);
	if (entry.body !== undefined)
		expect(parseJsonValue(request.body ?? "null")).toEqual(entry.body);
	else expect(request.body).toBeUndefined();
}

async function refusal(
	run: (client: ArcRunnerSetClient) => Promise<object | undefined>,
	entry: Interaction,
) {
	const { client } = replaying(entry);
	const error = await run(client).then(
		() => undefined,
		(caught) => caught,
	);
	expect(error).toBeInstanceOf(KubernetesProviderError);
	return error instanceof KubernetesProviderError ? error : undefined;
}

describe("ARC runner-set apiserver contract", () => {
	it("records where and when the surface was checked", () => {
		expect(source.url).toBe(
			"https://kubernetes.io/docs/reference/kubernetes-api/",
		);
		expect(stringAt(source.checkedAt, "checkedAt")).toMatch(
			/^\d{4}-\d{2}-\d{2}$/u,
		);
		expect(interactions.length).toBeGreaterThan(0);
	});

	it("lists the runner scale sets in a namespace", async () => {
		const entry = interaction("list the runner scale sets");
		const { client, requests } = replaying(entry);
		const list = await client.listRunnerSets("arc-runners");
		sent(requests, entry);
		expect(list).toEqual(entry.responseBody);
	});

	it("reads one runner scale set, and reads NotFound as absent", async () => {
		const found = interaction("read one runner scale set");
		const reading = replaying(found);
		expect(
			await reading.client.readRunnerSet("arc-runners", "hobo-trunk"),
		).toEqual(found.responseBody);
		sent(reading.requests, found);
		const gone = interaction("NotFound for a scale set");
		const missing = replaying(gone);
		expect(
			await missing.client.readRunnerSet("arc-runners", "hobo-gone"),
		).toBeUndefined();
		sent(missing.requests, gone);
	});

	it("sends the JSON patch with the json-patch media type", async () => {
		const entry = interaction("JSON-patch the node caches");
		const { client, requests } = replaying(entry);
		const patched = await client.patchRunnerSet(
			"arc-runners",
			"hobo-trunk",
			arrayBody(entry),
		);
		sent(requests, entry);
		expect(patched).toEqual(entry.responseBody);
	});

	it("reads a failed resourceVersion test as a conflict to retry", async () => {
		const entry = interaction("resourceVersion test no longer holds");
		const error = await refusal(
			(client) =>
				client.patchRunnerSet("arc-runners", "hobo-trunk", arrayBody(entry)),
			entry,
		);
		expect(error?.code).toBe("PROVISIONING_CONFLICT");
	});

	it("maps Forbidden to an auth failure without echoing the subject", async () => {
		const entry = interaction("not authorized");
		const error = await refusal(
			(client) =>
				client.patchRunnerSet("arc-runners", "hobo-trunk", arrayBody(entry)),
			entry,
		);
		expect(error?.code).toBe("PROVIDER_AUTH_FAILED");
		expect(error?.message).not.toContain(TOKEN);
	});

	it("creates the prewarm Job, and reads AlreadyExists as already done", async () => {
		const create = interaction("create the store prewarm Job");
		const creating = replaying(create);
		expect(
			await creating.client.createJob("arc-runners", objectBody(create)),
		).toBe("created");
		sent(creating.requests, create);
		const again = interaction("AlreadyExists");
		const repeating = replaying(again);
		expect(
			await repeating.client.createJob("arc-runners", objectBody(again)),
		).toBe("exists");
		sent(repeating.requests, again);
	});

	it("lists a scale set's prewarm Jobs by label selector", async () => {
		const entry = interaction("prewarm Jobs by label");
		const { client, requests } = replaying(entry);
		const list = await client.listJobs(
			"arc-runners",
			"hobo.ci/store-prewarm=hobo-trunk",
		);
		sent(requests, entry);
		expect(list).toEqual(entry.responseBody);
	});

	it("refuses names that would leave the runner-set routes before any call", async () => {
		const entry = interaction("read one runner scale set");
		const { client, requests } = replaying(entry);
		for (const attempt of [
			() => client.readRunnerSet("arc-runners", "../../../api/v1/secrets"),
			() => client.readRunnerSet("kube-system/secrets", "x"),
			() => client.listJobs("ARC", "a=b"),
		]) {
			const error = await attempt().then(
				() => undefined,
				(caught) => caught,
			);
			expect(error).toBeInstanceOf(KubernetesProviderError);
			expect(
				error instanceof KubernetesProviderError ? error.code : undefined,
			).toBe("ROUTE_REFUSED");
		}
		expect(requests).toEqual([]);
	});

	it("refuses a cleartext apiserver before a token is sent", () => {
		expect(() =>
			createArcRunnerSetClient({
				transport: async () => ({ status: 200, headers: {}, body: "{}" }),
				apiServerUrl: "http://arc.cluster.example.test:6443",
				bearerToken: TOKEN,
			}),
		).toThrow(KubernetesProviderError);
	});
});

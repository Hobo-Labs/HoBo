/**
 * Executable consumer side of the two PACT boundaries: the adapters are
 * driven against the exact request/response shapes recorded in
 * contracts/pacts/*.pact.json, so a drift between adapter and pact fails
 * here before any provider verification.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { actionsVariables } from "../../src/adapters/actions-variables.js";
import {
	foldLegacyActionsBilling,
	foldUsageItems,
	githubActionsUsage,
} from "../../src/adapters/github-billing.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "../../src/parse.js";

const PACTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pacts");

interface PactInteraction {
	description: string;
	request: {
		method: string;
		path: string;
		query?: string;
		body?: JsonValue;
	};
	response: { status: number; body?: JsonValue };
}

interface RecordedCall {
	method: string;
	url: string;
	body?: JsonValue;
}

interface PactFile {
	interactions: PactInteraction[];
}

function parsePactInteraction(value: JsonValue): PactInteraction {
	if (!isJsonObject(value)) throw new TypeError("pact interaction must be an object");
	const { description, request, response } = value;
	if (
		!isJsonString(description) ||
		!isJsonObject(request) ||
		!isJsonObject(response) ||
		!isJsonString(request.method) ||
		!isJsonString(request.path) ||
		!isJsonNumber(response.status)
	) {
		throw new TypeError("pact interaction has an invalid shape");
	}
	const interaction: PactInteraction = {
		description,
		request: { method: request.method, path: request.path },
		response: { status: response.status },
	};
	if (isJsonString(request.query)) interaction.request.query = request.query;
	if (request.body !== undefined) interaction.request.body = request.body;
	if (response.body !== undefined) interaction.response.body = response.body;
	return interaction;
}

function parsePactFile(value: JsonValue): PactFile {
	if (!isJsonObject(value) || !Array.isArray(value.interactions)) {
		throw new TypeError("pact file must contain an interactions array");
	}
	return { interactions: value.interactions.map(parsePactInteraction) };
}

async function loadPact(name: string): Promise<PactFile> {
	const text = await readFile(path.join(PACTS, name), "utf8");
	return parsePactFile(parseJsonValue(JSON.parse(text)));
}

function pactFetch(
	interactions: readonly PactInteraction[],
	calls: RecordedCall[],
): typeof fetch {
	return (input, init) => {
		const url = new URL(String(input));
		const method = (init?.method ?? "GET").toUpperCase();
		const record: RecordedCall = {
			method,
			url: url.pathname + url.search,
		};
		const body = init?.body;
		if (isJsonString(body)) {
			record.body = parseJsonValue(JSON.parse(body));
		}
		calls.push(record);
		const match = interactions.find(
			(interaction) =>
				interaction.request.method.toUpperCase() === method &&
				interaction.request.path === url.pathname,
		);
		if (match === undefined) {
			return Promise.resolve(new Response("not in pact", { status: 404 }));
		}
		return Promise.resolve(
			new Response(
				match.response.body === undefined
					? null
					: JSON.stringify(match.response.body),
				{ status: match.response.status },
			),
		);
	};
}

describe("pact: balancer-to-github-billing", () => {
	it("folds the enhanced billing usageItems the pact records", async () => {
		const pact = await loadPact("balancer-to-github-billing.pact.json");
		const body = pact.interactions[0]?.response.body;
		if (
			!isJsonObject(body) ||
			!Array.isArray(body.usageItems) ||
			!body.usageItems.every(isJsonObject)
		) {
			throw new Error("enhanced billing pact is missing usageItems objects");
		}
		const folded = foldUsageItems(body.usageItems);
		// Only the actions/minutes item counts; the packages item is ignored.
		expect(folded).toStrictEqual({ spendUsd: 13.2, unitsUsed: 2200 });
	});

	it("folds the legacy billing body the pact records", async () => {
		const pact = await loadPact("balancer-to-github-billing.pact.json");
		const body = pact.interactions[1]?.response.body;
		if (!isJsonObject(body)) {
			throw new Error("legacy billing pact response must be an object");
		}
		const folded = foldLegacyActionsBilling(body, 0.006);
		expect(folded.unitsUsed).toBe(305);
		expect(folded.spendUsd).toBeCloseTo(0.06, 10);
	});

	it("drives the adapter end-to-end against the pact responses", async () => {
		const pact = await loadPact("balancer-to-github-billing.pact.json");
		const calls: RecordedCall[] = [];
		const source = githubActionsUsage({
			owner: "hobo-operator",
			ownerKind: "user",
			token: "pact-token",
			env: {},
			fetchImpl: pactFetch(pact.interactions, calls),
		});
		const snapshot = await source.read();
		expect(snapshot.known).toBe(true);
		expect(snapshot.source).toBe("github-billing-usage");
		expect(snapshot.spendUsd).toBe(13.2);
		expect(snapshot.unitsUsed).toBe(2200);
		expect(calls[0]?.url).toContain(
			"/users/hobo-operator/settings/billing/usage",
		);
	});
});

describe("pact: balancer-to-actions-variables", () => {
	it("reads and patches the routed variable exactly as the pact records", async () => {
		const pact = await loadPact("balancer-to-actions-variables.pact.json");
		const calls: RecordedCall[] = [];
		const port = actionsVariables({
			owner: "Hobo-Labs",
			repo: "HoBo",
			token: "pact-token",
			fetchImpl: pactFetch(pact.interactions, calls),
		});

		await expect(port.get("HOBO_RUNNER_LINUX_SMALL")).resolves.toBe(
			"ubuntu-latest",
		);
		await port.set("HOBO_RUNNER_LINUX_SMALL", "blacksmith-2vcpu-ubuntu-2404");

		const patch = calls.find((call) => call.method === "PATCH");
		expect(patch?.url).toBe(
			"/repos/Hobo-Labs/HoBo/actions/variables/HOBO_RUNNER_LINUX_SMALL",
		);
		expect(patch?.body).toStrictEqual(
			pact.interactions[1]?.request.body,
		);
	});

	it("creates the variable via POST when the PATCH target is missing", async () => {
		const pact = await loadPact("balancer-to-actions-variables.pact.json");
		// Serve only the POST interaction so the PATCH 404s like a missing variable.
		const postOnly = pact.interactions.filter(
			(interaction) => interaction.request.method === "POST",
		);
		const calls: RecordedCall[] = [];
		const port = actionsVariables({
			owner: "Hobo-Labs",
			repo: "HoBo",
			token: "pact-token",
			fetchImpl: pactFetch(postOnly, calls),
		});

		await port.set("HOBO_RUNNER_LINUX_SMALL", "ubuntu-latest");
		const post = calls.find((call) => call.method === "POST");
		expect(post?.url).toBe("/repos/Hobo-Labs/HoBo/actions/variables");
		expect(post?.body).toStrictEqual(postOnly[0]?.request.body);
	});
});

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
import type { JsonValue } from "../../src/parse.js";

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

async function loadPact(name: string): Promise<PactFile> {
	// SAFETY: assertion to `JSON.parse(await readFile(path.join(PACTS, name), "utf8")) as PactFile` is required at this boundary.
	return JSON.parse(await readFile(path.join(PACTS, name), "utf8")) as PactFile;
}

function pactFetch(
	interactions: readonly PactInteraction[],
	calls: RecordedCall[],
): typeof fetch {
	// SAFETY: test fetch stand-in matches the Fetch API used by the adapters.
	return ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = (init?.method ?? "GET").toUpperCase();
		const record: RecordedCall = {
			method,
			url: url.pathname + url.search,
		};
		if (Object.prototype.toString.call(init?.body) === "[object String]") {
			const parsed = JSON.parse(String(init.body));
			// SAFETY: recorded request bodies are JSON fixtures.
			record.body = parsed as JsonValue;
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
	}) as typeof fetch;
}

describe("pact: balancer-to-github-billing", () => {
	it("folds the enhanced billing usageItems the pact records", async () => {
		const pact = await loadPact("balancer-to-github-billing.pact.json");
		// SAFETY: assertion to `pact.interactions[0]?.response.body as { usageItems: Parameters<typeof foldUsageItems>[0]; }` is required at this boundary.
		const body = pact.interactions[0]?.response.body as {
			usageItems: Parameters<typeof foldUsageItems>[0];
		};
		const folded = foldUsageItems(body.usageItems);
		// Only the actions/minutes item counts; the packages item is ignored.
		expect(folded).toStrictEqual({ spendUsd: 13.2, unitsUsed: 2200 });
	});

	it("folds the legacy billing body the pact records", async () => {
		const pact = await loadPact("balancer-to-github-billing.pact.json");
		// SAFETY: assertion to `pact.interactions[1]?.response.body as { total_minutes_used: number; total_paid_minutes_used: number; }` is required at this boundary.
		const body = pact.interactions[1]?.response.body as {
			total_minutes_used: number;
			total_paid_minutes_used: number;
		};
		const folded = foldLegacyActionsBilling(body, 0.006);
		expect(folded.unitsUsed).toBe(305);
		expect(folded.spendUsd).toBeCloseTo(0.06, 10);
	});

	it("drives the adapter end-to-end against the pact responses", async () => {
		const pact = await loadPact("balancer-to-github-billing.pact.json");
		const calls: Array<{ method: string; url: string }> = [];
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
		const calls: Array<{ method: string; url: string; body?: unknown }> = [];
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
		const calls: Array<{ method: string; url: string; body?: unknown }> = [];
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

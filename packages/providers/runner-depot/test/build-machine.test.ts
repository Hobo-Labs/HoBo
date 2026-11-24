import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CREDIT_EXHAUSTED } from "@hobo/runner-github";
import { describe, it } from "vitest";

import {
	BUILD_CACHE_HIT_OBSERVED,
	type CacheHitFact,
	createDepotBuildMachineProvider,
	createDepotClient,
	DEPOT_CACHE_LANE,
	DEPOT_CREDENTIALS_MISSING,
	DEPOT_EXECUTOR_MISSING,
	type DepotBuildExecutor,
	type DepotFetch,
	ownerDepotTokenProvider,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/runner-depot-boundary.pact.json"),
		"utf8",
	),
);
const RECORDED_CREATE = pact.interactions[0];
const RECORDED_SPEEDUP = pact.interactions[2].response.body;

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

function mockTransport() {
	const requests: RecordedRequest[] = [];
	const transport: DepotFetch = async (url, init) => {
		requests.push({
			url,
			method: init.method,
			headers: init.headers,
			...(init.body === undefined ? undefined : { body: init.body }),
		});
		if (url.endsWith("/CreateBuild")) {
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => RECORDED_CREATE.response.body,
			};
		}
		return {
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({ build_id: "bld_01", status: "finished" }),
		};
	};
	return { transport, requests };
}

// A warm-vs-cold executor fixture: the FIRST run of a BuildSpec meters 10
// cold minutes; the identical second run hits the shared cache and meters 1.
function warmingExecutor(): DepotBuildExecutor & { calls: number } {
	const seen = new Set<string>();
	const executor = {
		calls: 0,
		async execute(input: { buildId: string }) {
			executor.calls += 1;
			const warm = seen.has(input.buildId);
			seen.add(input.buildId);
			return {
				digest: String(RECORDED_SPEEDUP.image.digest),
				cacheHitRatio: warm ? 0.9 : 0,
				meteredUnits: warm ? 1 : 10,
			};
		},
	};
	return executor;
}

function machine(
	transport: DepotFetch,
	options: {
		executor?: DepotBuildExecutor;
		creditBudget?: { remainingUnits: number };
		onFact?: (fact: CacheHitFact) => void;
		token?: () => Promise<string>;
	} = {},
) {
	return createDepotBuildMachineProvider({
		client: createDepotClient({
			projectId: "hobo-builds",
			token: options.token ?? (async () => "expiring-project-token"),
			fetch: transport,
		}),
		registry: "registry.depot.dev/hobo-builds",
		...options,
	});
}

describe("Depot BuildMachineProvider (hobo:build-machine, replay lane)", () => {
	it("registers the build via the pact-recorded CreateBuild and returns the executor's pullable ImageRef", async () => {
		const { transport, requests } = mockTransport();
		const provider = machine(transport, { executor: warmingExecutor() });

		const image = await provider.execute({ buildId: "checkout-api" });

		const create = requests[0];
		assert.ok(create);
		assert.ok(create.url.endsWith(RECORDED_CREATE.request.path));
		assert.equal(create.method, RECORDED_CREATE.request.method);
		assert.equal(create.headers["content-type"], "application/json");
		assert.deepEqual(
			JSON.parse(create.body ?? "{}"),
			RECORDED_CREATE.request.body,
		);
		assert.equal(image.digest, RECORDED_SPEEDUP.image.digest);
		assert.equal(
			image.uri,
			`oci://registry.depot.dev/hobo-builds/checkout-api@${image.digest}`,
		);
	});

	it("the identical second build demonstrates the shared-cache speedup as recorded facts", async () => {
		const { transport } = mockTransport();
		const facts: CacheHitFact[] = [];
		const budget = { remainingUnits: 100 };
		const provider = machine(transport, {
			executor: warmingExecutor(),
			creditBudget: budget,
			onFact: (fact) => facts.push(fact),
		});

		await provider.execute({ buildId: "checkout-api", estimatedUnits: 10 });
		await provider.execute({ buildId: "checkout-api", estimatedUnits: 10 });

		assert.equal(facts.length, 2);
		const cold = facts[0];
		const warm = facts[1];
		assert.ok(cold);
		assert.ok(warm);
		assert.equal(cold.type, BUILD_CACHE_HIT_OBSERVED);
		assert.equal(cold.cacheLane, DEPOT_CACHE_LANE);
		// The pact-recorded sequence: cold 0/10 units, warm 0.9/1 unit.
		assert.equal(cold.cacheHitRatio, RECORDED_SPEEDUP.facts[0].cacheHitRatio);
		assert.equal(cold.meteredUnits, RECORDED_SPEEDUP.facts[0].meteredUnits);
		assert.equal(warm.cacheHitRatio, RECORDED_SPEEDUP.facts[1].cacheHitRatio);
		assert.equal(warm.meteredUnits, RECORDED_SPEEDUP.facts[1].meteredUnits);
		// Only OBSERVED units debit: 100 - 10 - 1 = 89, not 100 - 20.
		assert.equal(budget.remainingUnits, 89);
	});

	it("throws the typed credit.exhausted failure BEFORE any API call when over budget", async () => {
		const { transport, requests } = mockTransport();
		const provider = machine(transport, {
			executor: warmingExecutor(),
			creditBudget: { remainingUnits: 2 },
		});

		await assert.rejects(
			provider.execute({ buildId: "big", estimatedUnits: 5 }),
			(error: { code?: string }) => error.code === CREDIT_EXHAUSTED,
		);
		assert.equal(requests.length, 0);
	});

	it("fails closed with typed gates: missing executor, missing credentials", async () => {
		const { transport } = mockTransport();
		const noExecutor = machine(transport);
		await assert.rejects(
			noExecutor.execute({ buildId: "x" }),
			(error: { code?: string }) => error.code === DEPOT_EXECUTOR_MISSING,
		);

		const noToken = machine(transport, {
			executor: warmingExecutor(),
			token: ownerDepotTokenProvider({
				resolve: async () => {
					throw new Error("not in the store");
				},
			}),
		});
		await assert.rejects(
			noToken.execute({ buildId: "x" }),
			(error: { code?: string }) => error.code === DEPOT_CREDENTIALS_MISSING,
		);
	});
});

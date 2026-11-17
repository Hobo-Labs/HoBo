/**
 * Relay mode's facts and its one file (ADR-0183): `StoreRouteFacts` reads
 * fleet room, machines, spend, health and minutes from the relay's own
 * records, and `GithubCiOrderSource` reads `runnerOrder` from `.hobo/ci.json`
 * at the default branch or a pull request's base branch.
 */
import {
	newProviderHealth,
	providerHealthKey,
	recordProviderOutcome,
} from "@hobo/ci";
import {
	InMemoryMachineRegistry,
	InMemoryMinutesReader,
	InMemoryProviderHealthStore,
	InMemorySpendReader,
	routeFactsSourceConformance,
	runnerOrderSourceConformance,
	testMachineAdvert,
	testRouteRequest,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	GithubCiFile,
	GithubCiOrderSource,
	parseRelayJobs,
	pullRequestOfRef,
	RELAY_CONFIG_PATH,
} from "../src/relay-answer/ci-file.js";
import {
	type StoreFactsWarning,
	StoreRouteFacts,
	type StoreRouteFactsDeps,
} from "../src/relay-answer/store-facts.js";
import {
	GithubSimulator,
	simulatorTransport,
} from "./support/github-simulator/index.js";

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

function deps(init: Partial<StoreRouteFactsDeps> = {}): StoreRouteFactsDeps {
	return {
		accountId: "acct-1",
		fleet: undefined,
		machines: undefined,
		readers: undefined,
		spend: undefined,
		health: undefined,
		minutes: undefined,
		onWarning: undefined,
		...init,
	};
}

function leases(count: number) {
	return {
		activeLeases: async () =>
			Array.from({ length: count }, () => ({ accountId: "acct-1" })),
	};
}

describe("StoreRouteFacts", () => {
	it("keeps the facts source's rules with every store, and with none", async () => {
		await routeFactsSourceConformance(() => new StoreRouteFacts(deps()));
		await routeFactsSourceConformance(
			() =>
				new StoreRouteFacts(
					deps({
						fleet: { slots: 2, isolated: false, leases: leases(1) },
						machines: new InMemoryMachineRegistry(),
						spend: new InMemorySpendReader(),
						health: new InMemoryProviderHealthStore(),
						minutes: new InMemoryMinutesReader(),
					}),
				),
		);
	});

	it("has no fleet without one, and fleet room from the active leases", async () => {
		const none = await new StoreRouteFacts(deps()).facts(
			testRouteRequest(),
			NOW,
		);
		expect(none.fleet).toBeUndefined();
		const room = await new StoreRouteFacts(
			deps({ fleet: { slots: 2, isolated: true, leases: leases(1) } }),
		).facts(testRouteRequest(), NOW);
		expect(room.fleet).toEqual({ enabled: true, taking: true, isolated: true });
		const full = await new StoreRouteFacts(
			deps({ fleet: { slots: 2, isolated: false, leases: leases(2) } }),
		).facts(testRouteRequest(), NOW);
		expect(full.fleet).toEqual({
			enabled: true,
			taking: false,
			isolated: false,
		});
		const off = await new StoreRouteFacts(
			deps({ fleet: { slots: 0, isolated: false, leases: leases(0) } }),
		).facts(testRouteRequest(), NOW);
		expect(off.fleet).toBeUndefined();
	});

	it("offers the account's machines, online by advert age, readable by the readers given", async () => {
		const registry = new InMemoryMachineRegistry();
		await registry.put(
			testMachineAdvert({ id: "m-1", lastSeenMs: NOW - 10_000 }),
		);
		await registry.put(
			testMachineAdvert({ id: "m-2", lastSeenMs: NOW - 10 * 60_000 }),
		);
		await registry.put(testMachineAdvert({ id: "m-9", accountId: "acct-2" }));
		const asked: string[] = [];
		const facts = await new StoreRouteFacts(
			deps({
				machines: registry,
				readers: async (repository) => {
					asked.push(repository);
					return new Set(["42"]);
				},
			}),
		).facts(testRouteRequest("octo/app"), NOW);
		expect(asked).toEqual(["octo/app"]);
		expect(
			facts.machines.map((machine) => [
				machine.id,
				machine.online,
				machine.ownerCanRead,
			]),
		).toEqual([
			["m-1", true, true],
			["m-2", false, true],
		]);
	});

	it("reads spend from the start of the month, health now and minutes for the owner", async () => {
		const spend = new InMemorySpendReader(
			new Map([["acct-1", new Map([["depot", 12.5]])]]),
		);
		const health = new InMemoryProviderHealthStore();
		const key = providerHealthKey("depot", "depot-ubuntu-24.04");
		let tripped = newProviderHealth();
		for (const atMs of [NOW - 3_000, NOW - 2_000, NOW - 1_000])
			tripped = recordProviderOutcome(tripped, { atMs, started: false });
		await health.put(key, tripped);
		const minutes = new InMemoryMinutesReader(
			new Map([["octo", { usedMinutes: 100, includedMinutes: 2_000 }]]),
		);
		const facts = await new StoreRouteFacts(
			deps({ spend, health, minutes }),
		).facts(testRouteRequest("Octo/App"), NOW);
		expect(facts.spendUsd.get("depot")).toBe(12.5);
		expect(spend.asked).toEqual([
			{ accountId: "acct-1", monthStartMs: Date.UTC(2026, 10, 1) },
		]);
		expect(facts.unhealthy.has(key)).toBe(true);
		expect(facts.minutes).toEqual({ usedMinutes: 100, includedMinutes: 2_000 });
	});

	it("leaves a part unmeasured, with a warning, when its read fails", async () => {
		const warnings: StoreFactsWarning[] = [];
		const broken = new Error("store unreachable");
		const facts = await new StoreRouteFacts(
			deps({
				fleet: {
					slots: 2,
					isolated: false,
					leases: {
						activeLeases: async () => {
							throw broken;
						},
					},
				},
				spend: {
					spentUsd: async () => {
						throw broken;
					},
				},
				minutes: {
					usage: async () => {
						throw broken;
					},
				},
				health: {
					get: async () => newProviderHealth(),
					put: async () => undefined,
					unhealthy: async () => {
						throw broken;
					},
				},
				onWarning: (warning) => warnings.push(warning),
			}),
		).facts(testRouteRequest(), NOW);
		expect(facts.fleet).toBeUndefined();
		expect(facts.spendUsd.size).toBe(0);
		expect(facts.minutes).toBeUndefined();
		expect(facts.unhealthy.size).toBe(0);
		expect(warnings.map((warning) => warning.part).sort()).toEqual([
			"fleet",
			"health",
			"minutes",
			"spend",
		]);
		expect(warnings[0]?.message).toBe("store unreachable");
	});
});

describe("relayJobs in .hobo/ci.json", () => {
	it("is off unless the repository turns it on", () => {
		expect(parseRelayJobs(undefined)).toEqual({
			answer: false,
			label: "hobo-relay",
		});
		expect(parseRelayJobs("not json")).toEqual({
			answer: false,
			label: "hobo-relay",
		});
		expect(
			parseRelayJobs('{"runnerOrder":{"steps":[{"key":"github"}]}}'),
		).toEqual({ answer: false, label: "hobo-relay" });
		expect(parseRelayJobs('{"relayJobs":{"answer":true}}')).toEqual({
			answer: true,
			label: "hobo-relay",
		});
		expect(
			parseRelayJobs('{"relayJobs":{"answer":true,"label":"my-relay"}}'),
		).toEqual({ answer: true, label: "my-relay" });
		expect(
			parseRelayJobs('{"relayJobs":{"answer":"yes"}}'),
			"a malformed block leaves it off",
		).toEqual({ answer: false, label: "hobo-relay" });
	});

	it("reads a pull request number from its ref", () => {
		expect(pullRequestOfRef("refs/pull/12/merge")).toBe(12);
		expect(pullRequestOfRef("refs/heads/main")).toBeUndefined();
		expect(pullRequestOfRef(undefined)).toBeUndefined();
	});
});

describe("GithubCiOrderSource", () => {
	it("keeps the order source's rules over the contents API", async () => {
		await runnerOrderSourceConformance((orders) => {
			const sim = new GithubSimulator();
			for (const [repository, json] of orders)
				sim.putFile(repository, RELAY_CONFIG_PATH, `{"runnerOrder":${json}}`);
			sim.addRepository("octo/none");
			return new GithubCiOrderSource(
				new GithubCiFile(simulatorTransport(sim), 1),
			);
		});
	});

	it("reads the default branch, never the branch a run is testing", async () => {
		const sim = new GithubSimulator();
		sim.putFile(
			"octo/app",
			RELAY_CONFIG_PATH,
			'{"runnerOrder":{"steps":[{"key":"github"}]}}',
		);
		sim.putFile(
			"octo/app",
			RELAY_CONFIG_PATH,
			'{"runnerOrder":{"steps":[{"key":"machine"}]}}',
			"feature",
		);
		const source = new GithubCiOrderSource(
			new GithubCiFile(simulatorTransport(sim), 1),
		);
		const found = await source.order("octo/app", "refs/heads/feature");
		expect(found.order.steps.map((step) => step.key)).toEqual(["github"]);
		expect(
			sim
				.requests()
				.filter((request) => request.path.includes("/contents/"))
				.map((request) => request.query),
		).toEqual([""]);
	});

	it("reads a pull request's base branch, and the default branch when it cannot", async () => {
		const sim = new GithubSimulator();
		sim.putFile(
			"octo/app",
			RELAY_CONFIG_PATH,
			'{"runnerOrder":{"steps":[{"key":"github"}]}}',
		);
		sim.putFile(
			"octo/app",
			RELAY_CONFIG_PATH,
			'{"runnerOrder":{"steps":[{"key":"depot"}]}}',
			"release",
		);
		const transport = simulatorTransport(sim);
		const withPulls = {
			request: (
				installationId: number,
				path: string,
				method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
				body?: string,
			) =>
				path === "/repos/octo/app/pulls/7"
					? Promise.resolve(Response.json({ base: { ref: "release" } }))
					: transport.request(installationId, path, method, body),
		};
		const source = new GithubCiOrderSource(new GithubCiFile(withPulls, 1));
		const base = await source.order("octo/app", "refs/pull/7/merge");
		expect(base.order.steps.map((step) => step.key)).toEqual(["depot"]);
		const unknown = await source.order("octo/app", "refs/pull/8/merge");
		expect(unknown.order.steps.map((step) => step.key)).toEqual(["github"]);
	});

	it("gives a problem sentence when the file cannot be read", async () => {
		const source = new GithubCiOrderSource(
			new GithubCiFile(
				{ request: async () => new Response("boom", { status: 500 }) },
				1,
			),
		);
		const found = await source.order("octo/app", undefined);
		expect(found.problem).toMatch(/could not be read.*\(500\)/u);
	});
});

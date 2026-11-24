import { describe, expect, it } from "vitest";
import type { RouteJournal } from "../src/runner-order/ports.js";
import {
	InMemoryInsightStore,
	InMemoryMachineRegistry,
	InMemoryMinutesReader,
	InMemoryProviderHealthStore,
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	InMemorySpendReader,
	insightStoreConformance,
	machineRegistryConformance,
	minutesReaderConformance,
	PortConformanceError,
	providerHealthStoreConformance,
	routeFactsSourceConformance,
	routeJournalConformance,
	runnerOrderSourceConformance,
	spendReaderConformance,
} from "../src/runner-order/testing.js";

describe("in-memory ports pass their own conformance", () => {
	it("runner order source", () =>
		runnerOrderSourceConformance(
			(orders) => new InMemoryRunnerOrderSource(orders),
		));
	it("route facts source", () =>
		routeFactsSourceConformance(() => new InMemoryRouteFactsSource()));
	it("route journal", () =>
		routeJournalConformance(() => new InMemoryRouteJournal()));
	it("machine registry", () =>
		machineRegistryConformance(() => new InMemoryMachineRegistry()));
	it("provider health store", () =>
		providerHealthStoreConformance(() => new InMemoryProviderHealthStore()));
	it("minutes reader", () =>
		minutesReaderConformance(() => new InMemoryMinutesReader()));
	it("spend reader", () =>
		spendReaderConformance(() => new InMemorySpendReader()));
	it("insight store", () =>
		insightStoreConformance(() => new InMemoryInsightStore()));
});

describe("conformance functions catch a broken port", () => {
	it("names the rule a journal that keeps redeliveries breaks", async () => {
		const kept: Parameters<RouteJournal["record"]>[0][] = [];
		const careless: RouteJournal = {
			async record(event) {
				kept.push(event);
			},
			async decisions(query) {
				return kept
					.filter((event) => event.accountId === query.accountId)
					.sort((left, right) => right.atMs - left.atMs)
					.slice(0, query.limit);
			},
		};
		await expect(routeJournalConformance(() => careless)).rejects.toThrow(
			new PortConformanceError(
				"a redelivered event is kept once, and other accounts are left out",
			),
		);
	});

	it("names the rule an order source that hides a broken order breaks", async () => {
		const lenient = new InMemoryRunnerOrderSource();
		await expect(runnerOrderSourceConformance(() => lenient)).rejects.toThrow(
			PortConformanceError,
		);
	});

	it("names the rule a health store that forgets breaks", async () => {
		const forgetful = new InMemoryProviderHealthStore();
		forgetful.put = async () => {};
		await expect(
			providerHealthStoreConformance(() => forgetful),
		).rejects.toThrow("a record reads back as put");
	});
});

describe("in-memory fakes record what they were asked", () => {
	it("keeps the order source's and the facts source's questions", async () => {
		const orders = new InMemoryRunnerOrderSource();
		await orders.order("octo/app", "refs/heads/main");
		expect(orders.asked).toEqual([
			{ repository: "octo/app", ref: "refs/heads/main" },
		]);
		const facts = new InMemoryRouteFactsSource();
		await routeFactsSourceConformance(() => facts);
		expect(facts.asked).toHaveLength(1);
	});

	it("keeps every machine change with who made it", async () => {
		const registry = new InMemoryMachineRegistry();
		await machineRegistryConformance(() => registry);
		expect(registry.changes.map((entry) => entry.change)).toContain("paused");
		expect(registry.changes.at(-1)).toEqual({
			id: "m-1",
			change: "removed",
			by: "",
		});
	});
});

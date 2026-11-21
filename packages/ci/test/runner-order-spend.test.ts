import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { type Lease, LeaseSchema } from "../src/_generated/ci_pb.js";
import { type JobFact, JobFactSchema } from "../src/_generated/relay_job_pb.js";
import {
	HOSTED_LIST_PRICES,
	hostedListRate,
	RUNNER_FINANCIAL_MODELS,
} from "../src/fleet/models.js";
import {
	answerRelayJob,
	HOSTED_RUNNER_PROVIDERS,
	NO_ROUTE_FACTS,
	type RouteFacts,
	RUNNER_PROVIDER_CATALOG,
} from "../src/runner-order/index.js";
import {
	billedMinutes,
	LedgerSpendReader,
	listPriceOfJob,
	monthStartMs,
} from "../src/runner-order/spend.js";
import {
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	spendReaderConformance,
	testRelayJobMessage,
} from "../src/runner-order/testing.js";

const NOW = Date.UTC(2026, 10, 17, 12);
const MONTH = monthStartMs(NOW);

function lease(init: Partial<Omit<Lease, "$typeName" | "$unknown">>): Lease {
	return create(LeaseSchema, {
		id: "lease-1",
		accountId: "acct-1",
		provider: "depot",
		state: "completed",
		settledAt: new Date(MONTH + 60_000).toISOString(),
		...init,
	});
}

function job(init: Partial<Omit<JobFact, "$typeName" | "$unknown">>): JobFact {
	return create(JobFactSchema, {
		id: 1,
		name: "test",
		labels: ["depot-ubuntu-24.04-4"],
		conclusion: "success",
		queuedAtMs: MONTH + 1_000,
		startedAtMs: MONTH + 2_000,
		completedAtMs: MONTH + 2_000 + 10 * 60_000,
		...init,
	});
}

function reader(
	leases: readonly Lease[],
	jobs: readonly JobFact[] | undefined,
): LedgerSpendReader {
	return new LedgerSpendReader({
		ledger: { accountLeases: async () => leases },
		finishedJobs: jobs === undefined ? undefined : async () => jobs,
	});
}

describe("list prices (P04)", () => {
	it("cover every routable hosted provider, with a source and a day read", () => {
		for (const provider of HOSTED_RUNNER_PROVIDERS) {
			const price = HOSTED_LIST_PRICES.get(provider);
			expect(price, provider).toBeDefined();
			expect(price?.source).toMatch(/^https:\/\//u);
			expect(Date.parse(price?.observedAt ?? "")).not.toBeNaN();
			if (price?.kind === "unpriced")
				expect(price.reason.length).toBeGreaterThan(40);
		}
	});

	it("price every size label the runner-order catalog routes to", () => {
		for (const provider of HOSTED_RUNNER_PROVIDERS) {
			const price = HOSTED_LIST_PRICES.get(provider);
			if (price?.kind !== "priced") continue;
			expect(Date.parse(price.validUntil)).toBeGreaterThan(
				Date.parse(price.observedAt),
			);
			for (const size of RUNNER_PROVIDER_CATALOG.get(provider)?.sizes ?? []) {
				const rate = hostedListRate(provider, size.label);
				expect(rate, size.label).toBeDefined();
				expect(rate?.vcpus).toBe(size.vcpus);
				expect(Number(rate?.usdPerMinute)).toBeGreaterThan(0);
			}
		}
	});

	it("agree with the fleet models that price the same label", () => {
		for (const model of RUNNER_FINANCIAL_MODELS) {
			const rate = hostedListRate(model.provider, model.runsOn);
			if (rate)
				expect(Number(rate.usdPerMinute), model.id).toBe(
					Number(model.usdPerMinute),
				);
		}
	});

	it("record why RunsOn has no list price", () => {
		const runsOn = HOSTED_LIST_PRICES.get("runs-on");
		expect(runsOn?.kind).toBe("unpriced");
		expect(
			hostedListRate("runs-on", "runs-on=1/runner=2cpu-linux-x64"),
		).toBeUndefined();
	});
});

describe("LedgerSpendReader (R08)", () => {
	it("keeps the spend reader's rules", async () => {
		await spendReaderConformance(() => reader([], []));
	});

	it("starts the month on the first UTC day", () => {
		expect(new Date(MONTH).toISOString()).toBe("2026-11-01T00:00:00.000Z");
	});

	it("rounds per its billing", () => {
		expect(billedMinutes(61_000, "per-minute-ceil")).toBe(2);
		expect(billedMinutes(90_000, "per-second")).toBe(1.5);
		expect(billedMinutes(-5, "per-second")).toBe(0);
	});

	it("sums settled leases this month per provider", async () => {
		const spent = await reader(
			[
				lease({ id: "a", paidMicros: 2_500_000 }),
				lease({ id: "b", provider: "blacksmith", paidMicros: 1_000_000 }),
				lease({
					id: "c",
					paidMicros: 9_000_000,
					settledAt: new Date(MONTH - 1).toISOString(),
				}),
				lease({ id: "d", paidMicros: 9_000_000, settledAt: "" }),
				lease({ id: "e", provider: "hobo-box-worker", paidMicros: 9_000_000 }),
			],
			undefined,
		).spentUsd("acct-1", MONTH);
		expect(spent.get("depot")).toBe(2.5);
		expect(spent.get("blacksmith")).toBe(1);
		expect(spent.get("ubicloud")).toBe(0);
	});

	it("prices jobs no settled lease covers at the list rate", async () => {
		const spent = await reader(
			[lease({ jobId: 7, paidMicros: 500_000 })],
			[
				job({ id: 7 }),
				job({ id: 8 }),
				job({ id: 8 }),
				job({
					id: 9,
					labels: ["ubicloud-standard-2"],
					completedAtMs: MONTH + 2_000 + 61_000,
				}),
				job({ id: 10, labels: ["ubuntu-24.04"] }),
				job({ id: 11, labels: ["runs-on=1/runner=2cpu-linux-x64"] }),
				job({ id: 12, startedAtMs: undefined }),
			],
		).spentUsd("acct-1", MONTH);
		expect(spent.get("depot")).toBeCloseTo(0.5 + 10 * 0.012, 10);
		expect(spent.get("ubicloud")).toBeCloseTo(2 * 0.00125, 10);
		expect(spent.has("runs-on")).toBe(false);
	});

	it("covers only the job a lease ran when it ran another than it was made for", async () => {
		const spent = await reader(
			[lease({ jobId: 7, actualJobId: 8, paidMicros: 500_000 })],
			[job({ id: 7 }), job({ id: 8 })],
		).spentUsd("acct-1", MONTH);
		// Job 7 later ran on a hosted label without a lease: priced at list.
		expect(spent.get("depot")).toBeCloseTo(0.5 + 10 * 0.012, 10);
	});

	it("never throws when a source fails", async () => {
		const failing = new LedgerSpendReader({
			ledger: { accountLeases: async () => Promise.reject(new Error("down")) },
			finishedJobs: async () => Promise.reject(new Error("down")),
		});
		expect((await failing.spentUsd("acct-1", MONTH)).size).toBe(0);
	});

	it("leaves a label without a list rate unpriced", () => {
		expect(
			listPriceOfJob(job({ labels: ["depot-ubuntu-22.04-arm"] })),
		).toBeUndefined();
	});

	it("refuses a provider step once the ledger reaches its limit, and allows it below", async () => {
		const ledger = reader([lease({ paidMicros: 150_000_000 })], []);
		const answer = async (spendUsd: RouteFacts["spendUsd"]) => {
			const journal = new InMemoryRouteJournal();
			const result = await answerRelayJob(
				testRelayJobMessage({
					inputs: [
						["depot", "depot-ubuntu-24.04"],
						["github", "ubuntu-24.04"],
					],
				}),
				{
					order: new InMemoryRunnerOrderSource(
						new Map([
							[
								"octo/app",
								'{"steps":[{"key":"depot","spendLimitUsd":100},{"key":"github"}]}',
							],
						]),
					),
					facts: new InMemoryRouteFactsSource(() => ({
						...NO_ROUTE_FACTS,
						spendUsd,
					})),
					journal,
					nowMs: NOW,
					mode: "relay",
					node: "node-1",
					accountId: "acct-1",
					checks: undefined,
				},
			);
			return { result, journal };
		};
		const over = await answer(await ledger.spentUsd("acct-1", MONTH));
		const runner = over.result.outputs.find(
			(output) => output.name === "runner",
		);
		expect(runner?.value).toBe("ubuntu-24.04");
		const skip = over.journal.events
			.find((event) => event.type === "runner.route.Decided")
			?.decision?.skipped.find((entry) => entry.key === "depot");
		expect(skip?.reason).toBe("spend_limit");
		expect(skip?.detail).toContain("$150.00 of $100");
		const under = await answer(await reader([], []).spentUsd("acct-1", MONTH));
		expect(
			under.result.outputs.find((output) => output.name === "runner")?.value,
		).toBe("depot-ubuntu-24.04");
	});
});

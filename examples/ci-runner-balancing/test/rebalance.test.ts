import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
	DecisionKind,
	HardBlockSignalSchema,
	UsageSnapshotSchema,
} from "../src/_generated/runner_balancing_pb.js";
import {
	type FixtureDocument,
	parseFixtureDocument,
	parseJsonValue,
	parseUsageSnapshots,
	RegistryParseError,
} from "../src/parse.js";
import {
	type RebalanceDeps,
	runRebalance,
	type UsageSource,
} from "../src/rebalance.js";
import { DEFAULT_REGISTRY_DOCUMENT } from "../src/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function readFixture(
	name: string,
): Promise<
	Required<Pick<FixtureDocument, "current" | "usage" | "failures" | "seq">>
> {
	const text = await readFile(path.join(HERE, "..", "fixtures", name), "utf8");
	const fixture = parseFixtureDocument(parseJsonValue(JSON.parse(text)));
	if (
		fixture.current === undefined ||
		fixture.usage === undefined ||
		fixture.seq === undefined
	) {
		throw new Error(`${name} is missing current, usage, or seq`);
	}
	return {
		current: fixture.current,
		usage: fixture.usage,
		failures: fixture.failures ?? [],
		seq: fixture.seq,
	};
}

interface MemoryUsage {
	providerId: string;
	spendUsd?: number;
	unitsUsed?: number;
	known?: boolean;
}

interface MemoryOptions {
	current?: { readonly [name: string]: string };
	usage?: MemoryUsage[];
}

interface MemoryHarness {
	deps: RebalanceDeps;
	writes: Array<{ name: string; value: string }>;
}

function memoryDeps(options: MemoryOptions): MemoryHarness {
	const current = new Map(Object.entries(options.current ?? {}));
	const writes: Array<{ name: string; value: string }> = [];
	const usageSources: UsageSource[] = (options.usage ?? []).map((entry) => ({
		providerId: entry.providerId,
		read: () =>
			Promise.resolve(
				create(UsageSnapshotSchema, {
					providerId: entry.providerId,
					spendUsd: entry.spendUsd ?? 0,
					unitsUsed: entry.unitsUsed ?? 0,
					known: entry.known ?? true,
					source: "test",
				}),
			),
	}));
	return {
		deps: {
			variables: {
				get: (name) => Promise.resolve(current.get(name)),
				set: (name, value) => {
					current.set(name, value);
					writes.push({ name, value });
					return Promise.resolve();
				},
			},
			usageSources,
		},
		writes,
	};
}

describe("runRebalance", () => {
	it("plan mode decides without writing and pins the ledger seq everywhere", async () => {
		const { deps, writes } = memoryDeps({
			usage: [{ providerId: "github_hosted", unitsUsed: 100 }],
		});
		const result = await runRebalance(deps, {
			registryDocument: DEFAULT_REGISTRY_DOCUMENT,
			mode: "plan",
			requestedBy: "test",
			seq: "seq-9",
		});
		expect(writes).toHaveLength(0);
		expect(result.applied).toHaveLength(0);
		expect(result.plan.ledgerSeq).toBe("seq-9");
		for (const decision of result.plan.decisions) {
			expect(decision.ledgerSeq).toBe("seq-9");
		}
		expect(
			result.events.filter((event) => event.family === "meter.UsageRecorded"),
		).toHaveLength(1);
		expect(
			result.events.filter((event) => event.family === "dispatch.Decided"),
		).toHaveLength(result.plan.decisions.length);
	});

	it("apply mode patches variables for flips and records exec.Succeeded", async () => {
		const { deps, writes } = memoryDeps({
			usage: [{ providerId: "github_hosted", unitsUsed: 100 }],
		});
		const result = await runRebalance(deps, {
			registryDocument: DEFAULT_REGISTRY_DOCUMENT,
			mode: "apply",
			requestedBy: "test",
			seq: "seq-10",
		});
		// Unset variable adopts the eligible cheapest rung: GitHub-hosted free tier.
		expect(writes).toStrictEqual([
			{ name: "HOBO_RUNNER_LINUX_SMALL", value: "ubuntu-latest" },
		]);
		expect(result.applied).toHaveLength(1);
		expect(
			result.events.some((event) => event.family === "exec.Succeeded"),
		).toBe(true);
	});

	it("emits credit.Exhausted when a declared free tier has no headroom left", async () => {
		const { deps } = memoryDeps({
			usage: [{ providerId: "github_hosted", unitsUsed: 2400, spendUsd: 2.4 }],
		});
		const result = await runRebalance(deps, {
			registryDocument: DEFAULT_REGISTRY_DOCUMENT,
			mode: "plan",
			requestedBy: "test",
			seq: "seq-11",
		});
		expect(
			result.events.some(
				(event) =>
					event.family === "credit.Exhausted" &&
					event.payload.providerId === "github_hosted",
			),
		).toBe(true);
	});

	it("rejects a structurally broken registry document at the parse boundary", async () => {
		const { deps } = memoryDeps({});
		await expect(
			runRebalance(deps, {
				registryDocument: {
					providers: [],
					tracks: [
						{
							resource: "runner.linux.small",
							variable: "X",
							rungs: [{ value: "a", providerId: "ghost" }],
						},
					],
					envelopes: [],
				},
				mode: "plan",
				requestedBy: "test",
				seq: "seq-12",
			}),
		).rejects.toBeInstanceOf(RegistryParseError);
	});

	it("replays the shipped last-resort fixture: a spending-limit hard block fails over to the requesting machine", async () => {
		const fixture = await readFixture("last-resort-failover.fixture.json");
		const snapshots = parseUsageSnapshots(fixture.usage);
		const { deps } = memoryDeps({ current: fixture.current });
		const result = await runRebalance(
			{
				...deps,
				usageSources: snapshots.map((snapshot) => ({
					providerId: snapshot.providerId,
					read: () => Promise.resolve(snapshot),
				})),
				failureSignals: () =>
					Promise.resolve(
						fixture.failures.map((failure) =>
							create(HardBlockSignalSchema, {
								providerId: failure.providerId,
								resource: "",
								reason: failure.reason,
							}),
						),
					),
			},
			{
				registryDocument: DEFAULT_REGISTRY_DOCUMENT,
				mode: "plan",
				requestedBy: "fixture",
				seq: fixture.seq,
			},
		);
		const decision = result.plan.decisions[0];
		// GitHub-hosted is hard-blocked (spending limit) and no third-party
		// provider is enabled: instead of failing closed, the dispatcher
		// fails over to the requesting machine's last-resort label.
		expect(decision?.kind).toBe(DecisionKind.FLIP);
		expect(decision?.toValue).toBe("hobo-last-resort");
		expect(decision?.providerId).toBe("requesting_machine");
		expect(decision?.reason).toContain("last resort");
	});

	it("replays the shipped free-credit-rotation fixture to the Blacksmith rung", async () => {
		const fixture = await readFixture("free-credit-rotation.fixture.json");
		const snapshots = parseUsageSnapshots(fixture.usage);
		expect(snapshots).toHaveLength(3);
		const { deps } = memoryDeps({ current: fixture.current });
		const result = await runRebalance(
			{
				...deps,
				usageSources: snapshots.map((snapshot) => ({
					providerId: snapshot.providerId,
					read: () => Promise.resolve(snapshot),
				})),
			},
			{
				registryDocument: DEFAULT_REGISTRY_DOCUMENT,
				mode: "plan",
				requestedBy: "fixture",
				seq: fixture.seq,
			},
		);
		const decision = result.plan.decisions[0];
		// GitHub's included minutes are exhausted (2200 > 2000) while
		// Blacksmith still has free headroom: free credits win over GitHub's
		// realtime billing even though GitHub is still under its envelope.
		expect(decision?.kind).toBe(DecisionKind.FLIP);
		expect(decision?.toValue).toBe("blacksmith-2vcpu-ubuntu-2404");
		expect(decision?.usageKnown).toBe(true);
		expect(
			result.events.some((event) => event.family === "credit.Exhausted"),
		).toBe(true);
	});
});

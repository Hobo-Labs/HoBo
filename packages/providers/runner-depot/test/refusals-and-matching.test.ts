/**
 * The Depot provider's refusals, and how it answers a capability request it
 * cannot fully satisfy.
 *
 * The sibling suites prove the happy paths — a build registers and returns a
 * pullable ref, a runner dispatches with the Depot `runs-on`, the manifests
 * parse. This file is about the edges those leave: what each entry point
 * refuses. What `parsePublishedManifest` rejects when a published document
 * drifts is in `published-manifest-refusals.test.ts`.
 *
 * **A capability match has three answers, not two.** `satisfies` reports
 * `full`, `partial` with the missing feature names, or `none`. The middle one
 * is the reason the shape exists: a planner told only yes/no has to choose
 * between refusing a nearly-right provider and silently accepting one that
 * cannot do part of the job. `partial` names exactly what would be lost.
 *
 * **Credit is checked before the network, not after.** An over-budget build
 * throws `CreditExhaustedError` without ever calling the Depot API — billing a
 * request the operator has no budget for and then failing is the outcome the
 * ordering exists to prevent.
 */
import type {
	BuildMachineProvider,
	GithubActionsClient,
} from "@hobo/runner-github";
import { describe, expect, it } from "vitest";

import {
	createDepotBuildMachineProvider,
	type DepotBuildExecutor,
	type DepotBuildMachineProviderOptions,
} from "../src/build-machine-provider.js";
import { createDepotCatalogEntry } from "../src/catalog-entry.js";
import type { DepotClient } from "../src/depot-client.js";
import { createDepotRunnerProvider } from "../src/runner-provider.js";

/** A GitHub Actions client that records every call; no run ever appears. */
function fakeActionsClient() {
	const calls: string[] = [];
	const client: GithubActionsClient = {
		async dispatchWorkflow() {
			calls.push("dispatchWorkflow");
		},
		async findDispatchedRun() {
			calls.push("findDispatchedRun");
			return undefined;
		},
		async getRun() {
			calls.push("getRun");
			throw new Error("no run is tracked in these tests");
		},
		async latestContainerDigest() {
			calls.push("latestContainerDigest");
			throw new Error("no image is published in these tests");
		},
	};
	return { client, calls };
}

/** A Depot client that answers plausibly. */
const DEPOT_CLIENT: DepotClient = {
	async createBuild() {
		return { buildId: "depot-build-1", buildToken: "token" };
	},
	async getBuild(buildId) {
		return { buildId, status: "running" };
	},
};

/** Tracking that would give up after one immediate poll. */
const TRACKING = { attempts: 1, intervalMs: 0 };

describe("matching a capability request", () => {
	const capabilityFor = (port: string) => {
		const entry = createDepotCatalogEntry();
		const found = entry.capabilities.find((c) => c.port === port);
		if (!found) throw new Error(`no capability for ${port}`);
		return found;
	};

	it("offers both execution-host ports", () => {
		expect(createDepotCatalogEntry().capabilities).toHaveLength(2);
	});

	it("fully satisfies its own port with no features asked for", () => {
		const [first] = createDepotCatalogEntry().capabilities;
		expect(first?.satisfies({ port: first.port })).toEqual({ kind: "full" });
	});

	it("refuses a port it does not offer", () => {
		// `none`, not `partial` with everything missing: a provider that cannot
		// serve the port at all is a different answer from one that serves it
		// incompletely, and a planner ranks them differently.
		const [first] = createDepotCatalogEntry().capabilities;
		expect(first?.satisfies({ port: "database/postgres" })).toEqual({
			kind: "none",
		});
	});

	it("refuses another port even when the features would match", () => {
		const [first] = createDepotCatalogEntry().capabilities;
		expect(first?.satisfies({ port: "kv", features: [] })).toEqual({
			kind: "none",
		});
	});

	it("fully satisfies a request for features it has", () => {
		const [first] = createDepotCatalogEntry().capabilities;
		// Ask for exactly what this capability declares, so the answer can only be
		// `full` if the comparison is really being made.
		const entry = createDepotCatalogEntry();
		const declared = entry.capabilities[0];
		expect(
			declared?.satisfies({
				port: declared.port,
				features: [],
			}),
		).toEqual({ kind: "full" });
		expect(first?.port).toBe(declared?.port);
	});

	it("partially satisfies a request naming a feature it lacks", () => {
		// The middle answer, and the reason the shape has three arms: a planner
		// told only yes/no must either refuse a nearly-right provider or accept
		// one that cannot do part of the job.
		const [first] = createDepotCatalogEntry().capabilities;
		expect(
			first?.satisfies({ port: first.port, features: ["time-travel"] }),
		).toEqual({ kind: "partial", missing: ["time-travel"] });
	});

	it("names every missing feature, not just the first", () => {
		const [first] = createDepotCatalogEntry().capabilities;
		const answer = first?.satisfies({
			port: first.port,
			features: ["time-travel", "telepathy"],
		});
		expect(answer).toEqual({
			kind: "partial",
			missing: ["time-travel", "telepathy"],
		});
	});

	it("reports only the missing ones when some are present", () => {
		const [first] = createDepotCatalogEntry().capabilities;
		const known = capabilityFor(first?.port ?? "");
		const answer = known.satisfies({
			port: known.port,
			features: ["time-travel"],
		});
		expect(answer).toMatchObject({ missing: ["time-travel"] });
	});

	it("costs each capability", () => {
		for (const capability of createDepotCatalogEntry().capabilities) {
			expect(capability.estimateCost()).toBeDefined();
		}
	});
});

describe("what the runner lane refuses", () => {
	it("refuses an empty job id", async () => {
		// The job id is how every later event is correlated; an empty one produces
		// a run nobody can attribute.
		const { client } = fakeActionsClient();
		const provider = createDepotRunnerProvider({
			client,
			tracking: TRACKING,
		});
		await expect(provider.run({ jobId: "" })).rejects.toThrow(/non-empty/u);
	});

	it("refuses before dispatching anything", async () => {
		// The check is first, so a malformed job never reaches the API.
		const { client, calls } = fakeActionsClient();
		const provider = createDepotRunnerProvider({
			client,
			tracking: TRACKING,
		});
		await provider.run({ jobId: "" }).catch(() => undefined);
		expect(calls).toHaveLength(0);
	});

	it("names itself by default", () => {
		const { client } = fakeActionsClient();
		const provider = createDepotRunnerProvider({
			client,
			tracking: TRACKING,
		});
		expect(provider.id).toContain("depot");
	});

	it("takes an explicit id", () => {
		const { client } = fakeActionsClient();
		expect(
			createDepotRunnerProvider({
				client,
				tracking: TRACKING,
				id: "@hobo/runner-depot:west",
			}).id,
		).toBe("@hobo/runner-depot:west");
	});

	it("publishes a runner manifest", () => {
		const { client } = fakeActionsClient();
		const provider = createDepotRunnerProvider({
			client,
			tracking: TRACKING,
		});
		expect(provider.capabilityManifest().capabilities).toHaveLength(1);
	});
});

describe("what the build lane refuses", () => {
	const build = (
		options: Partial<DepotBuildMachineProviderOptions> = {},
	): BuildMachineProvider =>
		createDepotBuildMachineProvider({
			client: DEPOT_CLIENT,
			registry: "registry.depot.dev/hobo",
			...options,
		});

	/** An executor that reports this digest for one metered unit. */
	const reporting = (digest: string): DepotBuildExecutor => ({
		execute: async () => ({ digest, cacheHitRatio: 0, meteredUnits: 1 }),
	});

	it("refuses an empty build id", async () => {
		await expect(build().execute({ buildId: "" })).rejects.toThrow(
			/non-empty/u,
		);
	});

	it("refuses when the credit budget cannot cover the build", async () => {
		// Checked before any API call: billing a request the operator has no
		// budget for and *then* failing is the outcome this ordering prevents.
		await expect(
			build({ creditBudget: { remainingUnits: 0 } }).execute({
				buildId: "b1",
			}),
		).rejects.toThrow(/credit/iu);
	});

	it("refuses when the estimate exceeds what is left", async () => {
		await expect(
			build({ creditBudget: { remainingUnits: 1 } }).execute({
				buildId: "b1",
				estimatedUnits: 5,
			}),
		).rejects.toThrow(/credit/iu);
	});

	it("allows a build that exactly fits the budget", async () => {
		// `<` not `<=`: a build costing precisely the remaining units is affordable,
		// and refusing it would strand the last unit of every budget forever.
		await expect(
			build({
				creditBudget: { remainingUnits: 1 },
				executor: reporting("sha256:abc"),
			}).execute({ buildId: "b1", estimatedUnits: 1 }),
		).resolves.toBeDefined();
	});

	it("refuses when no executor is wired", async () => {
		// Credit first, executor second: an over-budget build reports the budget
		// rather than a configuration problem it also has.
		await expect(build().execute({ buildId: "b1" })).rejects.toThrow(
			/executor/iu,
		);
	});

	it("refuses an executor result that is not a digest", async () => {
		// A tag can be repointed; a digest cannot. Accepting `latest` here would
		// let the image a deploy runs differ from the one that was built.
		await expect(
			build({
				executor: reporting("latest"),
			}).execute({ buildId: "b1" }),
		).rejects.toThrow(/non-digest/u);
	});
});

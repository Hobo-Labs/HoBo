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

const DEPOT_CLIENT: DepotClient = {
	async createBuild() {
		return { buildId: "depot-build-1", buildToken: "token" };
	},
	async getBuild(buildId) {
		return { buildId, status: "running" };
	},
};

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
		const { client } = fakeActionsClient();
		const provider = createDepotRunnerProvider({
			client,
			tracking: TRACKING,
		});
		await expect(provider.run({ jobId: "" })).rejects.toThrow(/non-empty/u);
	});

	it("refuses before dispatching anything", async () => {
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

	const reporting = (digest: string): DepotBuildExecutor => ({
		execute: async () => ({ digest, cacheHitRatio: 0, meteredUnits: 1 }),
	});

	it("refuses an empty build id", async () => {
		await expect(build().execute({ buildId: "" })).rejects.toThrow(
			/non-empty/u,
		);
	});

	it("refuses when the credit budget cannot cover the build", async () => {
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
		await expect(
			build({
				creditBudget: { remainingUnits: 1 },
				executor: reporting("sha256:abc"),
			}).execute({ buildId: "b1", estimatedUnits: 1 }),
		).resolves.toBeDefined();
	});

	it("refuses when no executor is wired", async () => {
		await expect(build().execute({ buildId: "b1" })).rejects.toThrow(
			/executor/iu,
		);
	});

	it("refuses an executor result that is not a digest", async () => {
		await expect(
			build({
				executor: reporting("latest"),
			}).execute({ buildId: "b1" }),
		).rejects.toThrow(/non-digest/u);
	});
});

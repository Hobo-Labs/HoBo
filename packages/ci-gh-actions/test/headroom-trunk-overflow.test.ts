import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	JobSchema,
} from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { createHeadroomTrunkOverflow } from "../src/isolated-worker/headroom-trunk-overflow.js";
import { createWorkerMemoryAdmission } from "../src/isolated-worker/memory-admission.js";
import { job, NOW } from "./fixtures.js";

const stores: SqliteCiStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function trunkStore() {
	const store = new SqliteCiStore(":memory:");
	stores.push(store);
	const configuration = create(ConfigurationSchema, {
		accounts: [
			create(AccountSchema, {
				id: "customer",
				maxRuntimeMinutes: 30,
				startupMinutes: 5,
				offers: [
					{
						id: "box",
						provider: "hobo-box-worker",
						providerAccountId: "worker",
						backend: "isolated-container",
						enabled: true,
						runsOn: "hobo-isolated-worker",
						concurrency: 2,
						observedAt: NOW,
						validUntil: "2030-01-01T00:00:00Z",
						sourceUrl: "https://example.test/evidence",
						bridgeAcknowledged: true,
						priceMicrosPerMinute: 0,
					},
				],
			}),
		],
		connections: [
			create(ConnectionSchema, {
				accountId: "customer",
				repository: "org/repo",
				repositoryId: 101,
				installationId: 10,
				runnerGroupId: 1,
				isolatedOnly: true,
				acceptAllMatchingRepositoryJobs: true,
				trustedRepositoryAcknowledged: true,
				publicRepositoryAcknowledged: true,
			}),
		],
	});
	await store.configure(configuration, 0, NOW);
	return store;
}

it("re-runs a trunk job still queued after headroom wait, without re-queuing on hobo", async () => {
	const store = await trunkStore();
	const trunk = create(JobSchema, {
		...job(),
		labels: ["hobo-trunk"],
		name: "Main full gate",
		memoryMb: 4096,
	});
	await store.queue(trunk, NOW, 1);
	const github = {
		request: async (_installation: number, path: string, method?: string) => {
			if (path === "/repos/org/repo/actions/jobs/1")
				return Response.json({
					id: 1,
					run_id: 11,
					run_attempt: 1,
					status: "queued",
					labels: ["hobo-trunk"],
				});
			if (path === "/repos/org/repo/actions/runs/11/rerun" && method === "POST")
				return new Response(null, { status: 201 });
			throw new Error(`unexpected ${method ?? "GET"} ${path}`);
		},
	} satisfies GithubTransport;
	const memoryAdmission = createWorkerMemoryAdmission(
		{
			budgetMb: 8192,
			reserveMb: 2048,
			holMs: 60_000,
			classes: { light: 3072, standard: 4096, heavy: 6144 },
			unmeasured: { light: 1024, standard: 2048, heavy: 4096 },
			trunkReservationMb: 4096,
			learn: false,
		},
		{ availableMemoryMb: () => 2400, now: () => Date.now() },
	);
	const overflow = createHeadroomTrunkOverflow({
		github,
		memoryAdmission,
		availableMemoryMb: () => 2400,
		volatilityMb: 1024,
		overflowAfterMs: 0,
		now: () => Date.now(),
	});
	const trunkWaits = new Map([
		[
			"org/repo:1:1",
			{
				sinceMs: Date.now() - 130_000,
				logged: true,
				reason: "headroom" as const,
			},
		],
	]);
	const count = await overflow.overflowTrunkJobsWaitingForHeadroom(
		store,
		trunkWaits,
		1,
		NOW,
	);
	expect(count).toBe(1);
	expect(await store.pendingJobs()).toEqual([]);
	expect(trunkWaits.has("org/repo:1:1")).toBe(false);
});

it("does not overflow while memory headroom still admits the trunk job", async () => {
	const store = await trunkStore();
	const trunk = create(JobSchema, { ...job(), labels: ["hobo-trunk"] });
	await store.queue(trunk, NOW, 1);
	const github = {
		request: vi.fn(async () => {
			throw new Error("unexpected github call");
		}),
	} satisfies GithubTransport;
	const memoryAdmission = createWorkerMemoryAdmission(
		{
			budgetMb: 8192,
			reserveMb: 2048,
			holMs: 60_000,
			classes: { light: 3072, standard: 4096, heavy: 6144 },
			unmeasured: { light: 1024, standard: 2048, heavy: 4096 },
			trunkReservationMb: 4096,
			learn: false,
		},
		{ availableMemoryMb: () => 9000, now: () => Date.now() },
	);
	const overflow = createHeadroomTrunkOverflow({
		github,
		memoryAdmission,
		availableMemoryMb: () => 9000,
		volatilityMb: 1024,
		overflowAfterMs: 0,
		now: () => Date.now(),
	});
	const count = await overflow.overflowTrunkJobsWaitingForHeadroom(
		store,
		new Map([
			[
				"org/repo:1:1",
				{
					sinceMs: Date.now() - 200_000,
					logged: true,
					reason: "headroom" as const,
				},
			],
		]),
		1,
		NOW,
	);
	expect(count).toBe(0);
	expect(await store.pendingJobs()).toHaveLength(1);
});

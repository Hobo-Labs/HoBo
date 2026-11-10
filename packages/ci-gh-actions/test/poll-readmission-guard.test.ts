import { create } from "@bufbuild/protobuf";
import { AccountSchema, ConfigurationSchema, ConnectionSchema } from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { HostedRelay } from "../src/hosted-relay.js";
import { job, NOW, queued, run, SECRET } from "./fixtures.js";

const stores: SqliteCiStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function isolatedRelay(github: GithubTransport) {
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
	const reconcile = vi.fn(async () => undefined);
	const relay = new HostedRelay({
		config: configuration,
		store,
		github,
		identity: {
			async verify() {
				throw new Error("unexpected");
			},
		},
		webhookSecret: SECRET,
		isolatedHost: { launch: vi.fn(), reconcile },
		now: () => NOW,
	});
	return { store, relay, reconcile };
}

it("yields box custody when GitHub queued job names an ARC runner", async () => {
	const github = {
		request: async (_installation: number, path: string) => {
			if (path === "/repos/org/repo/actions/runs/11")
				return Response.json(run());
			if (path === "/repos/org/repo/actions/jobs/1")
				return Response.json({
					id: 1,
					run_id: 11,
					run_attempt: 1,
					status: "queued",
					labels: ["hobo"],
					runner_name: "hobo-runner-arc",
				});
			throw new Error(`unexpected: ${path}`);
		},
	} satisfies GithubTransport;
	const { store, relay, reconcile } = await isolatedRelay(github);
	const account = (await store.configuration())?.configuration?.accounts[0];
	if (!account) throw new Error("fixture account");
	const demand = job();
	await store.queue(demand, NOW, 1);
	const lease = await store.reserve(account, demand, NOW, 1);
	if (!lease) throw new Error("fixture lease");
	await store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.state = "dispatching";
			entry.runnerName = `hobo-${lease.id}`;
		},
		"ci.DispatchRequested",
		NOW,
		1,
	);
	const body = queued();
	body.workflow_job.runner_name = "hobo-runner-arc";
	const result = await relay.processWebhook(
		Buffer.from(JSON.stringify(body)),
		"workflow_job",
	);
	expect(result).toBe("foreign-runner");
	expect(reconcile).toHaveBeenCalledWith(lease.id, true);
	expect(await store.activeLeases()).toEqual([]);
	expect(await store.pendingJobs()).toEqual([]);
});

it("does not queue again when dispatching lease already owns the JIT runner", async () => {
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
	const account = (await store.configuration())?.configuration?.accounts[0];
	if (!account) throw new Error("fixture account");
	const demand = job();
	await store.queue(demand, NOW, 1);
	const lease = await store.reserve(account, demand, NOW, 1);
	if (!lease) throw new Error("fixture lease");
	const leaseRunner = `hobo-${lease.id}`;
	await store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.runnerName = leaseRunner;
		},
		"ci.RunnerRegistered",
		NOW,
		1,
	);
	const github = {
		request: async (_installation: number, path: string) => {
			if (path === "/repos/org/repo/actions/runs/11")
				return Response.json(run());
			if (path === "/repos/org/repo/actions/jobs/1")
				return Response.json({
					id: 1,
					run_id: 11,
					run_attempt: 1,
					status: "queued",
					labels: ["hobo"],
					runner_name: leaseRunner,
				});
			throw new Error(`unexpected: ${path}`);
		},
	} satisfies GithubTransport;
	const relay = new HostedRelay({
		config: configuration,
		store,
		github,
		identity: {
			async verify() {
				throw new Error("unexpected");
			},
		},
		webhookSecret: SECRET,
		now: () => NOW,
	});
	const body = queued();
	body.workflow_job.runner_name = leaseRunner;
	const queue = vi.spyOn(store, "queue");
	expect(
		await relay.processWebhook(Buffer.from(JSON.stringify(body)), "workflow_job"),
	).toBe("duplicate");
	expect(queue).not.toHaveBeenCalled();
	expect(await store.activeLeases()).toHaveLength(1);
});

import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { createHostedRelayRuntime } from "../src/hosted-runtime.js";
import { config, job, NOW, queued, run, SECRET } from "./fixtures.js";

const stores: SqliteCiStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function fixture() {
	const store = new SqliteCiStore(":memory:");
	stores.push(store);
	await store.configure(config(), 0, NOW);
	let nowMs = Date.parse(NOW);
	const github = { jobStatus: "queued" };
	const request = vi.fn<GithubTransport["request"]>(
		async (_installation, path) => {
			if (path === "/repos/org/repo/actions/runs/11")
				return Response.json(run());
			if (path === "/repos/org/repo/actions/jobs/1")
				return Response.json({
					id: 1,
					run_id: 11,
					run_attempt: 1,
					status: github.jobStatus,
					labels: ["hobo"],
				});
			throw new Error(`unexpected GitHub request: ${path}`);
		},
	);
	const runtime = createHostedRelayRuntime({
		store,
		github: { request },
		identity: {
			async verify() {
				throw new Error("unexpected identity verification");
			},
		},
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => new Date(nowMs).toISOString(),
	});
	const input = {
		deliveryId: "poll-1-1-q",
		event: "workflow_job",
		rawBody: Buffer.from(JSON.stringify(queued())),
		receivedAt: NOW,
	} satisfies Parameters<typeof runtime.ingestWebhook>[0];
	return {
		store,
		runtime,
		request,
		input,
		github,
		advance(ms: number) {
			nowMs += ms;
		},
	};
}

it("requeues an uncovered duplicate queued delivery", async () => {
	const h = await fixture();
	const queue = vi.spyOn(h.store, "queue");
	expect(await h.runtime.ingestWebhook(h.input)).toBe("accepted");
	expect(await h.runtime.ingestWebhook(h.input)).toBe("requeued");
	expect(queue).toHaveBeenCalledWith(
		expect.objectContaining({ id: 1, runAttempt: 1, repositoryId: 101 }),
		new Date(NOW).toISOString(),
		expect.any(Number),
	);
});

it("does not re-check a duplicate with pending demand", async () => {
	const h = await fixture();
	await h.store.queue(job(), NOW);
	expect(await h.runtime.ingestWebhook(h.input)).toBe("accepted");
	expect(await h.runtime.ingestWebhook(h.input)).toBe("duplicate");
	expect(h.request).not.toHaveBeenCalled();
});

it("does not re-check a duplicate with a lease serving the job", async () => {
	const h = await fixture();
	await h.store.queue(job(), NOW);
	const account = (await h.store.configuration())?.configuration?.accounts[0];
	if (!account) throw new Error("missing fixture account");
	expect(await h.store.reserve(account, job(), NOW)).toBeDefined();
	expect(await h.runtime.ingestWebhook(h.input)).toBe("accepted");
	expect(await h.runtime.ingestWebhook(h.input)).toBe("duplicate");
	expect(h.request).not.toHaveBeenCalled();
});

it("requeues a duplicate whose lease runner was taken by another job", async () => {
	const h = await fixture();
	await h.store.queue(job(), NOW);
	const account = (await h.store.configuration())?.configuration?.accounts[0];
	if (!account) throw new Error("missing fixture account");
	const lease = await h.store.reserve(account, job(), NOW);
	if (!lease) throw new Error("missing fixture lease");
	await h.store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.actualJobId = 2;
		},
		"ci.RunnerClaimed",
		NOW,
	);
	expect(await h.runtime.ingestWebhook(h.input)).toBe("accepted");
	expect(await h.runtime.ingestWebhook(h.input)).toBe("requeued");
	expect(h.request).toHaveBeenCalledTimes(2);
});

it("re-admits a re-polled queued job after its earlier lease is terminal", async () => {
	const h = await fixture();
	const account = (await h.store.configuration())?.configuration?.accounts[0];
	if (!account) throw new Error("missing fixture account");
	const earlier = await h.store.reserve(account, job(), NOW);
	if (!earlier) throw new Error("missing earlier lease");
	await h.store.transition(
		earlier.id,
		["reserved"],
		(entry) => {
			entry.state = "cancelled";
		},
		"ci.LeaseCancelled",
		NOW,
	);

	expect(await h.runtime.ingestWebhook(h.input)).toBe("accepted");
	await h.runtime.tick({ maxDeliveries: 1 });

	const active = await h.store.activeLeases();
	expect(active).toHaveLength(1);
	expect(active[0]).toMatchObject({ jobId: 1 });
	expect(active[0]?.id).not.toBe(earlier.id);
});

it("limits an uncovered duplicate to one GitHub re-check per minute", async () => {
	const h = await fixture();
	vi.spyOn(h.store, "pendingJobs").mockResolvedValue([]);
	expect(await h.runtime.ingestWebhook(h.input)).toBe("accepted");
	expect(await h.runtime.ingestWebhook(h.input)).toBe("requeued");
	expect(h.request).toHaveBeenCalledTimes(2);
	expect(await h.runtime.ingestWebhook(h.input)).toBe("duplicate");
	expect(h.request).toHaveBeenCalledTimes(2);
	h.advance(60_000);
	expect(await h.runtime.ingestWebhook(h.input)).toBe("requeued");
	expect(h.request).toHaveBeenCalledTimes(4);
});

it("does not queue a duplicate whose GitHub job is no longer queued", async () => {
	const h = await fixture();
	const queue = vi.spyOn(h.store, "queue");
	expect(await h.runtime.ingestWebhook(h.input)).toBe("accepted");
	h.github.jobStatus = "completed";
	expect(await h.runtime.ingestWebhook(h.input)).toBe("duplicate");
	expect(queue).not.toHaveBeenCalled();
	expect(h.request).toHaveBeenCalledTimes(2);
});

it("contains a failed duplicate re-check", async () => {
	const h = await fixture();
	expect(await h.runtime.ingestWebhook(h.input)).toBe("accepted");
	h.request.mockRejectedValue(new Error("GitHub unavailable"));
	expect(await h.runtime.ingestWebhook(h.input)).toBe("duplicate");
});

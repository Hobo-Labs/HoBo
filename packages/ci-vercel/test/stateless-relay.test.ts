import { ACTIVE_STATES } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHttpEntry } from "../src/entry.js";
import { RELAY_QUEUE_TOPICS } from "../src/relay-queue.js";
import { INVITATION, ORIGIN, openStatelessRelay } from "./stateless-harness.js";

const JOB = 4001;
const MINUTE = 60_000;

/** The lease ids in flight for the fixture's account, through the store's own read. */
async function leases(h: Awaited<ReturnType<typeof openStatelessRelay>>) {
	return h.relay.store.accountLeases("hobo-labs");
}

/** The account's change ring, as MCP's `wait_for_events` reads it. */
async function feed(h: Awaited<ReturnType<typeof openStatelessRelay>>) {
	const page = await h.relay.store.eventsSince({
		accountId: "hobo-labs",
		limit: 100,
	});
	return page.events.map((entry) => entry.event?.type);
}

/** Run the repair tick once so a fresh cache's holds are known (priced Sandbox offers admit). */
async function warm(h: Awaited<ReturnType<typeof openStatelessRelay>>) {
	await h.relay.run({
		kind: "repair",
		source: "static",
		platformSchedule: false,
	});
	expect(await h.relay.store.accountsAwaitingRebuild()).toEqual([]);
}

describe("the stateless relay, end to end on the in-memory cache", () => {
	it("runs a Sandbox job: webhook, intake queue, reserve, dispatch, claim, completed, settle", async () => {
		const h = await openStatelessRelay();
		await warm(h);
		h.jobs.set(JOB, {
			id: JOB,
			status: "queued",
			runnerName: null,
			runnerId: null,
		});

		// The webhook is verified, enqueued keyed by its delivery id, and
		// acknowledged; nothing is admitted before the queue delivers it.
		const queued = await h.webhook("queued", JOB);
		expect(queued.response.status).toBe(202);
		expect(await queued.response.json()).toEqual({ status: "accepted" });
		const intake = h.sent.filter(
			(entry) => entry.topic === RELAY_QUEUE_TOPICS.intake,
		);
		expect(intake).toEqual([
			{
				topic: RELAY_QUEUE_TOPICS.intake,
				options: expect.objectContaining({
					idempotencyKey: queued.deliveryId,
				}),
			},
		]);
		expect(await leases(h)).toEqual([]);

		// The consumer admits the job and the Sandbox host launches it at once:
		// reserve, dispatch (proxy and guest VMs), claim (JIT registration) and
		// start, each a transition of one lease record.
		await h.drain(RELAY_QUEUE_TOPICS.intake);
		const [lease] = await leases(h);
		if (!lease) throw new Error("no lease");
		expect(lease.state).toBe("running");
		expect(lease.runnerName).toBe(`hobo-${lease.id}`);
		expect(h.sandbox.creates).toBe(1);
		expect(h.github.jitRegistrations).toBe(1);

		// The proxy VM was handed the lease's derived token, nothing stored:
		// the quota endpoint takes the raw bearer and the store checks its MAC.
		expect(h.sandbox.quotaTokens).toEqual([
			h.relay.store.sandboxProxyToken(lease.id),
		]);
		const quota = await h.relay.handle(
			new Request(`${ORIGIN}/internal/sandbox/quota`, {
				method: "POST",
				headers: { authorization: `Bearer ${h.sandbox.quotaTokens[0]}` },
				body: JSON.stringify({
					leaseId: lease.id,
					proxySessionId: lease.proxySandboxSessionId,
					sandboxId: lease.sandboxSessionId,
					bytes: 100,
					requestId: "00000000-0000-4000-8000-000000000001",
				}),
			}),
		);
		expect(quota.status).toBe(204);

		// Each step chain the lease entered has its first rung on the queue,
		// keyed by lease, step and rung; nothing scans other leases.
		const steps = h.queued
			.filter((entry) => entry.topic === RELAY_QUEUE_TOPICS.steps)
			.map((entry) => entry.key);
		expect(steps.sort()).toEqual([
			`${lease.id}:claim-timeout:0`,
			`${lease.id}:dispatch-check:0`,
			`${lease.id}:reconcile:0`,
		]);

		// GitHub assigns the job to the Sandbox's runner.
		const github = h.github.job(JOB);
		github.status = "in_progress";
		github.runnerName = lease.runnerName;
		github.runnerId = 31;
		expect((await h.webhook("in_progress", JOB)).response.status).toBe(202);
		await h.drain(RELAY_QUEUE_TOPICS.intake);
		expect((await h.relay.store.get(lease.id))?.actualJobId).toBe(JOB);

		// A minute on: the dispatch and claim checks find the lease running and
		// end their chains; the reconcile step finds the runner still busy.
		await h.after(MINUTE);
		expect((await h.relay.store.get(lease.id))?.state).toBe("running");
		expect(h.sandbox.stops).toBe(0);
		expect(
			h.queued
				.filter((entry) => entry.topic === RELAY_QUEUE_TOPICS.steps)
				.map((entry) => entry.key),
		).toEqual([`${lease.id}:reconcile:1`]);

		// The job finishes: the runner exits and GitHub says completed.
		github.status = "completed";
		const vm = h.vms.get(`hobo-${lease.id}`);
		if (!vm) throw new Error("no guest vm");
		vm.exitCode = 0;
		expect((await h.webhook("completed", JOB)).response.status).toBe(202);
		await h.drain(RELAY_QUEUE_TOPICS.intake);

		// The next reconcile step stops both VMs, deletes the runner and
		// settles from the measured usage.
		await h.after(2 * MINUTE);
		const settled = await h.relay.store.get(lease.id);
		expect(settled?.state).toBe("completed");
		expect(settled?.settledAt).not.toBe("");
		expect(settled?.runnerDeletionConfirmed).toBe(true);
		expect(h.sandbox.stops).toBe(1);
		expect(
			(await h.relay.store.activeLeases()).filter((entry) =>
				ACTIVE_STATES.has(entry.state),
			),
		).toEqual([]);

		// The ring holds what MCP follows: state changes, not every write.
		expect(await feed(h)).toEqual([
			"ci.JobQueued",
			"ci.LeaseReserved",
			"ci.DispatchRequested",
			"ci.SandboxCreated",
			"ci.RunnerClaimed",
			"ci.SandboxRunnerStarted",
			"ci.HostSettled",
		]);

		// The chain ends: the step after settlement reads the lease and stops.
		await h.after(10 * MINUTE);
		expect(
			h.queued.filter((entry) => entry.topic === RELAY_QUEUE_TOPICS.steps),
		).toEqual([]);
	});

	it("collapses duplicate deliveries: one lease, one Sandbox, one runner", async () => {
		const h = await openStatelessRelay();
		await warm(h);
		h.jobs.set(JOB, {
			id: JOB,
			status: "queued",
			runnerName: null,
			runnerId: null,
		});
		const first = await h.webhook("queued", JOB, "delivery-a");
		expect(first.response.status).toBe(202);
		// GitHub delivers the same delivery again before the queue ran it.
		const again = await h.webhook("queued", JOB, "delivery-a");
		expect(again.response.status).toBe(202);
		// The platform delivers the intake message at least once: twice here.
		const message = h.queued.find(
			(entry) => entry.topic === RELAY_QUEUE_TOPICS.intake,
		);
		if (!message) throw new Error("no intake message");
		await h.drain(RELAY_QUEUE_TOPICS.intake);
		await h.redeliver(message.payload);
		// A redelivery from GitHub's history arrives under a new delivery id.
		await h.webhook("queued", JOB, "delivery-b");
		await h.drain(RELAY_QUEUE_TOPICS.intake);

		expect((await leases(h)).map((lease) => lease.state)).toEqual(["running"]);
		expect(h.sandbox.creates).toBe(1);
		expect(h.github.jitRegistrations).toBe(1);
		// The intake send for "delivery-a" happened once; the duplicate POST
		// was answered from the delivery marker.
		expect(
			h.sent.filter(
				(entry) =>
					entry.topic === RELAY_QUEUE_TOPICS.intake &&
					entry.options.idempotencyKey === "delivery-a",
			),
		).toHaveLength(1);
	});

	it("rebuilds a lease the cache lost mid-job, from GitHub and Vercel by name, and provisions nothing twice", async () => {
		const h = await openStatelessRelay();
		await warm(h);
		h.jobs.set(JOB, {
			id: JOB,
			status: "queued",
			runnerName: null,
			runnerId: null,
		});
		await h.webhook("queued", JOB);
		await h.drain(RELAY_QUEUE_TOPICS.intake);
		const [lease] = await leases(h);
		if (!lease) throw new Error("no lease");
		const github = h.github.job(JOB);
		github.status = "in_progress";
		github.runnerName = lease.runnerName;
		github.runnerId = 31;

		// The cache is gone: no lease, no job record, no index, no ring.
		h.wipeCache();
		expect(await h.relay.store.get(lease.id)).toBeUndefined();
		expect(await h.relay.store.accountsAwaitingRebuild()).toEqual([
			"hobo-labs",
		]);

		// A late queued delivery (GitHub's redelivery, new id) finds the job in
		// progress at GitHub and admits nothing.
		await h.webhook("queued", JOB);
		await h.drain(RELAY_QUEUE_TOPICS.intake);
		expect(h.sandbox.creates).toBe(1);

		// The lease's step messages survived in the queue. The first one due
		// finds no record and rebuilds it by name: GitHub shows the job on the
		// lease's runner, Vercel the Sandbox under the lease's name.
		await h.after(MINUTE);
		const rebuilt = await h.relay.store.get(lease.id);
		expect(rebuilt?.state).toBe("uncertain");
		expect(rebuilt?.sandboxName).toBe(`hobo-${lease.id}`);
		expect(rebuilt?.actualJobId).toBe(JOB);
		expect(h.lines).toContainEqual(
			expect.objectContaining({
				event: "hobo_ci_lease_rebuild",
				leaseId: lease.id,
				outcome: "rebuilt",
			}),
		);
		// It holds capacity again; the repair tick's rebuild pass lists what
		// GitHub has in flight and marks the account's holds known.
		await h.relay.run({
			kind: "repair",
			source: "static",
			platformSchedule: false,
		});
		expect(await h.relay.store.accountsAwaitingRebuild()).toEqual([]);
		expect((await leases(h)).map((entry) => entry.id)).toEqual([lease.id]);

		// GitHub's runner is still running the job: the rebuilt lease is
		// adopted, not stopped, and nothing is provisioned twice.
		await h.after(5 * MINUTE);
		expect(h.sandbox.stops).toBe(0);
		expect(h.sandbox.creates).toBe(1);
		expect(h.github.jitRegistrations).toBe(1);
		expect(h.failures).toEqual([]);

		// Once GitHub reports the job finished, both VMs are stopped (the proxy
		// found by its name). The relay's proxy counters went with the cache,
		// but the proxy VM kept its own: it is read back before the VM stops,
		// the runner GitHub assigned is deleted, and the lease settles.
		h.sandbox.proxyMeters.set(`hobo-proxy-${lease.id}`, {
			bytes: 262_144,
			calls: 4,
		});
		github.status = "completed";
		const guest = h.vms.get(`hobo-${lease.id}`);
		if (!guest) throw new Error("no guest vm");
		guest.exitCode = 0;
		await h.after(15 * MINUTE);
		expect(guest.stopped).toBe(true);
		expect(h.vms.get(`hobo-proxy-${lease.id}`)?.stopped).toBe(true);
		expect(h.sandbox.meterReads).toBe(1);
		const settled = await h.relay.store.get(lease.id);
		expect(settled?.state).toBe("completed");
		expect(settled?.runnerId).toBe(31);
		expect(settled?.runnerDeletionConfirmed).toBe(true);
		expect(h.github.requests).toContain(
			"DELETE /repos/Org/Repo/actions/runners/31",
		);
		expect(h.failures).toEqual([]);
		expect(h.sandbox.creates).toBe(1);
	});

	it("charges a rebuilt Sandbox lease what its proxy VM counted, never less", async () => {
		const settle = async (meter: { bytes: number; calls: number }) => {
			const h = await openStatelessRelay();
			await warm(h);
			h.jobs.set(JOB, {
				id: JOB,
				status: "queued",
				runnerName: null,
				runnerId: null,
			});
			await h.webhook("queued", JOB);
			await h.drain(RELAY_QUEUE_TOPICS.intake);
			const [lease] = await leases(h);
			if (!lease) throw new Error("no lease");
			const github = h.github.job(JOB);
			github.status = "in_progress";
			github.runnerName = lease.runnerName;
			github.runnerId = 31;
			h.wipeCache();
			await h.after(MINUTE);
			h.sandbox.proxyMeters.set(`hobo-proxy-${lease.id}`, meter);
			github.status = "completed";
			const guest = h.vms.get(`hobo-${lease.id}`);
			if (guest) guest.exitCode = 0;
			await h.after(15 * MINUTE);
			return h.relay.store.get(lease.id);
		};
		const idle = await settle({ bytes: 0, calls: 0 });
		const busy = await settle({ bytes: 500_000, calls: 40 });
		expect(idle?.state).toBe("completed");
		expect(busy?.state).toBe("completed");
		// The proxy's bytes and calls are priced in: more traffic, a larger charge.
		expect(busy?.paidMicros ?? 0).toBeGreaterThan(idle?.paidMicros ?? 0);
	});

	it("leaves a rebuilt Sandbox lease unsettled when neither the cache nor the proxy VM has its meter", async () => {
		const h = await openStatelessRelay();
		await warm(h);
		h.jobs.set(JOB, {
			id: JOB,
			status: "queued",
			runnerName: null,
			runnerId: null,
		});
		await h.webhook("queued", JOB);
		await h.drain(RELAY_QUEUE_TOPICS.intake);
		const [lease] = await leases(h);
		if (!lease) throw new Error("no lease");
		const github = h.github.job(JOB);
		github.status = "in_progress";
		github.runnerName = lease.runnerName;
		github.runnerId = 31;
		h.wipeCache();
		await h.after(MINUTE);
		h.sandbox.proxyMeterAnswers = false;
		github.status = "completed";
		const guest = h.vms.get(`hobo-${lease.id}`);
		if (guest) guest.exitCode = 0;
		await h.after(15 * MINUTE);
		expect(h.vms.get(`hobo-proxy-${lease.id}`)?.stopped).toBe(true);
		// Fail closed for money: it holds its capacity until its record lapses.
		expect((await h.relay.store.get(lease.id))?.state).toBe("uncertain");
		expect(h.failures.map((failure) => failure.message)).toContain(
			"sandbox proxy meter missing",
		);
	});
});

describe("the stateless relay's configuration is read-only", () => {
	it.each([
		["PUT", "/v1/accounts/self/policy"],
		["PUT", "/v2/accounts/self/policy"],
		["PUT", "/v2/accounts/self/providers"],
		["POST", "/v2/accounts/self/signals"],
		["POST", "/v2/accounts/self/observations"],
		["POST", "/v2/accounts/self/rate-observations"],
		["GET", "/v2/accounts/self/inbox/quarantined"],
		["POST", "/v1/accounts/self/repositories/prepare"],
		["POST", "/v1/accounts/self/repositories/isolated-connect"],
	])("refuses %s %s with 410, naming the config service", async (method, path) => {
		const h = await openStatelessRelay();
		const init: RequestInit = {
			method,
			headers: {
				authorization: `Bearer ${h.token}`,
				"if-match": '"1"',
				"content-type": "application/json",
			},
		};
		if (method !== "GET") init.body = "{}";
		const response = await h.relay.handle(
			new Request(`${ORIGIN}${path}`, init),
		);
		expect(response.status).toBe(410);
		const body = await response.json();
		expect(body).toMatchObject({ configService: "env" });
		expect(body.error).toMatch(/read-only.*hobo ci.*config service/u);
	});

	it("keeps a fleet verdict on the cache: reported by the account, read by anyone, gone when it lapses", async () => {
		const h = await openStatelessRelay();
		const path = "/v1/fleet/verdicts/Org/Repo";
		const read = async (at = path) => {
			const response = await h.relay.handle(new Request(`${ORIGIN}${at}`));
			expect(response.status).toBe(200);
			return response.json();
		};
		expect(await read()).toEqual({ repository: "org/repo", blocked: {} });
		// Configuration is read-only here; a verdict is not configuration.
		const reported = await h.relay.handle(
			new Request(`${ORIGIN}${path}`, {
				method: "PUT",
				headers: {
					authorization: `Bearer ${h.token}`,
					"content-type": "application/json",
				},
				body: '{"blocked":{"hobo":{"reason":"no-capacity"}},"ttlSeconds":120}',
			}),
		);
		expect(reported.status).toBe(200);
		expect((await read()).blocked).toEqual({
			hobo: { reason: "no-capacity" },
		});
		h.clock.advance(119_000);
		expect((await read()).blocked).toEqual({
			hobo: { reason: "no-capacity" },
		});
		h.clock.advance(1_000);
		expect(await read()).toEqual({ repository: "org/repo", blocked: {} });
	});

	it("does not touch the cache for a repository it has no connection to, however it is named", async () => {
		const h = await openStatelessRelay();
		const before = h.cache.meter.usage().total;
		for (const name of [
			"acme/unknown",
			"x1/Repo",
			`${"a".repeat(39)}/${"b".repeat(100)}`,
		]) {
			const response = await h.relay.handle(
				new Request(`${ORIGIN}/v1/fleet/verdicts/${name}`),
			);
			expect(response.status).toBe(200);
			expect((await response.json()).blocked).toEqual({});
		}
		expect(h.cache.meter.usage().total).toBe(before);
		// An owner longer than GitHub allows names no repository.
		const long = await h.relay.handle(
			new Request(
				`${ORIGIN}/v1/fleet/verdicts/${"a".repeat(100)}/${"b".repeat(100)}`,
			),
		);
		expect(long.status).toBe(404);
	});

	it("still serves the policy view, read from the config service", async () => {
		const h = await openStatelessRelay();
		const response = await h.relay.handle(
			new Request(`${ORIGIN}/v1/accounts/self/policy`, {
				headers: { authorization: `Bearer ${h.token}` },
			}),
		);
		expect(response.status).toBe(200);
	});
});

describe("the stateless relay's probes", () => {
	it("is ready when the config service and the cache answer and a host is configured", async () => {
		const h = await openStatelessRelay();
		const response = await h.relay.handle(new Request(`${ORIGIN}/readyz`));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ready: true,
			configService: true,
			configStale: false,
			cache: true,
			executionHost: true,
			workers: "starting",
		});
	});

	it("is not ready, and says why, when the cache does not answer", async () => {
		let down = false;
		const h = await openStatelessRelay({ failCache: () => down });
		down = true;
		const response = await h.relay.handle(new Request(`${ORIGIN}/readyz`));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			ready: false,
			configService: true,
			cache: false,
		});
		// Liveness does not depend on the cache.
		expect(
			(await h.relay.handle(new Request(`${ORIGIN}/healthz`))).status,
		).toBe(200);
	});

	it("answers /healthz 200 and /readyz 503 while the relay cannot start", async () => {
		const { createServer } = await import("node:http");
		const server = createServer(
			createHttpEntry(async () => {
				throw new Error("config service unreachable");
			}),
		);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const { port } = z.object({ port: z.number() }).parse(server.address());
			const base = `http://127.0.0.1:${port}`;
			const health = await fetch(`${base}/healthz`);
			expect(health.status).toBe(200);
			expect(await health.json()).toEqual({ ok: true, commit: null });
			const ready = await fetch(`${base}/readyz`);
			expect(ready.status).toBe(503);
			expect(await ready.json()).toEqual({
				ready: false,
				started: false,
				state: "start-failed",
			});
			expect((await fetch(`${base}/github/webhooks`)).status).toBe(503);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});

describe("the stateless relay's cache commands per Sandbox job", () => {
	it("meters each phase of one job, pinned so a change in cost is a reviewed change", async () => {
		const h = await openStatelessRelay();
		await warm(h);
		const cost: Record<string, number> = {};
		const phase = async (name: string, run: () => Promise<number | object>) => {
			const before = h.cache.meter.usage().total;
			await run();
			cost[name] = h.cache.meter.usage().total - before;
		};
		h.jobs.set(JOB, {
			id: JOB,
			status: "queued",
			runnerName: null,
			runnerId: null,
		});
		await phase("webhook queued", () => h.webhook("queued", JOB));
		await phase("intake: queue, reserve, launch", () =>
			h.drain(RELAY_QUEUE_TOPICS.intake),
		);
		const [lease] = await leases(h);
		if (!lease) throw new Error("no lease");
		const github = h.github.job(JOB);
		github.status = "in_progress";
		github.runnerName = lease.runnerName;
		github.runnerId = 31;
		await phase("webhook in_progress", () => h.webhook("in_progress", JOB));
		await phase("intake: in_progress", () =>
			h.drain(RELAY_QUEUE_TOPICS.intake),
		);
		await phase("steps: three first rungs", () => h.after(MINUTE));
		github.status = "completed";
		const vm = h.vms.get(`hobo-${lease.id}`);
		if (vm) vm.exitCode = 0;
		await phase("webhook completed", () => h.webhook("completed", JOB));
		await phase("intake: completed", () => h.drain(RELAY_QUEUE_TOPICS.intake));
		await phase("step: stop and settle", () => h.after(2 * MINUTE));
		await phase("step: chain end", () => h.after(10 * MINUTE));
		expect((await h.relay.store.get(lease.id))?.state).toBe("completed");
		// Every delivery costs its markers (3); the launch is a run of lease
		// transitions, each one compare-and-set plus the routing check a held
		// state takes, with a ring append per state change; a step reads one
		// lease. The usage counter adds one command per relay-clock minute in
		// which a call was made (the fleet's flush follows the relay's clock),
		// so a phase that crosses a minute carries one more.
		// Settling reads the proxy VM's own meter before stopping it and keeps
		// it (3: the lease, the meter, its write).
		expect(cost).toEqual({
			"webhook queued": 3,
			"intake: queue, reserve, launch": 56,
			"webhook in_progress": 3,
			"intake: in_progress": 6,
			"steps: three first rungs": 5,
			"webhook completed": 3,
			"intake: completed": 2,
			"step: stop and settle": 24,
			"step: chain end": 2,
		});
		expect(Object.values(cost).reduce((sum, value) => sum + value, 0)).toBe(
			104,
		);
	});
});

describe("the stateless relay's repair scanners, on the cache", () => {
	it("redelivers a delivery GitHub failed to deliver, once per cooldown", async () => {
		const h = await openStatelessRelay();
		const delivered = new Date(h.clock.nowMs() - 5 * MINUTE).toISOString();
		h.deliveries.push(
			{
				id: 71,
				guid: "missed",
				event: "workflow_job",
				status_code: 502,
				delivered_at: delivered,
			},
			{
				id: 72,
				guid: "fine",
				event: "workflow_job",
				status_code: 200,
				delivered_at: delivered,
			},
		);
		await warm(h);
		expect(h.redeliveries).toEqual([71]);
		await h.relay.run({
			kind: "repair",
			source: "static",
			platformSchedule: false,
		});
		expect(h.redeliveries).toEqual([71]);
		// After the 15-minute cooldown GitHub's history still shows it failed.
		h.clock.advance(16 * MINUTE);
		await h.relay.run({
			kind: "repair",
			source: "static",
			platformSchedule: false,
		});
		expect(h.redeliveries).toEqual([71, 71]);
	});

	it("does not redeliver a delivery the relay already took in", async () => {
		const h = await openStatelessRelay();
		await warm(h);
		h.jobs.set(JOB, {
			id: JOB,
			status: "queued",
			runnerName: null,
			runnerId: null,
		});
		const { deliveryId } = await h.webhook("queued", JOB, "taken-in");
		h.deliveries.push({
			id: 73,
			guid: deliveryId,
			event: "workflow_job",
			status_code: 502,
			delivered_at: new Date(h.clock.nowMs() - 5 * MINUTE).toISOString(),
		});
		await h.relay.run({
			kind: "repair",
			source: "static",
			platformSchedule: false,
		});
		expect(h.redeliveries).toEqual([]);
	});

	it("admits a queued job whose delivery never came, and after a cache loss replaces its idle runner, never two at once", async () => {
		const h = await openStatelessRelay();
		await warm(h);
		h.jobs.set(JOB, {
			id: JOB,
			status: "queued",
			runnerName: null,
			runnerId: null,
		});
		// No webhook: the queued scan finds the job at GitHub within a few ticks.
		for (let tick = 0; tick < 4 && (await leases(h)).length === 0; tick++) {
			h.clock.advance(15 * MINUTE);
			await h.relay.run({
				kind: "repair",
				source: "static",
				platformSchedule: false,
			});
		}
		const [lease] = await leases(h);
		expect(lease?.jobId).toBe(JOB);
		expect(h.sandbox.creates).toBe(1);
		// The cache is lost before GitHub assigned the job. The rebuild pass
		// finds the Sandbox by name; the host cannot tell an idle runner from a
		// busy one without the lost record, so it stops both VMs, deletes the
		// runner and settles from the proxy VM's meter; the job, still queued,
		// is admitted once more under the next generation. Never two live VMs.
		if (!lease) throw new Error("no lease");
		h.wipeCache();
		for (let tick = 0; tick < 2; tick++) {
			h.clock.advance(MINUTE);
			await h.relay.run({
				kind: "repair",
				source: "static",
				platformSchedule: false,
			});
		}
		expect((await h.relay.store.get(lease.id))?.state).toBe("completed");
		expect(h.vms.get(`hobo-${lease.id}`)?.stopped).toBe(true);
		const live = (await leases(h)).filter((entry) =>
			ACTIVE_STATES.has(entry.state),
		);
		expect(live).toHaveLength(1);
		expect(live[0]?.id).not.toBe(lease.id);
		expect(h.sandbox.creates).toBe(2);
		expect(
			[...h.vms.entries()].filter(
				([name, vm]) =>
					name.startsWith("hobo-") &&
					!name.startsWith("hobo-proxy-") &&
					!vm.stopped,
			),
		).toHaveLength(1);
	});

	it("reports worker health from the cache: starting, then ok, then failing", async () => {
		const h = await openStatelessRelay();
		const ready = async () =>
			z
				.object({ ready: z.boolean(), workers: z.string() })
				.parse(
					await (await h.relay.handle(new Request(`${ORIGIN}/readyz`))).json(),
				);
		expect(await ready()).toEqual({ ready: true, workers: "starting" });
		for (let tick = 0; tick < 2; tick++) {
			h.clock.advance(15 * MINUTE);
			await h.relay.run({
				kind: "repair",
				source: "static",
				platformSchedule: false,
			});
		}
		expect(await ready()).toEqual({ ready: true, workers: "ok" });
		h.appApi.down = true;
		h.clock.advance(15 * MINUTE);
		await h.relay.run({
			kind: "repair",
			source: "static",
			platformSchedule: false,
		});
		expect(await ready()).toEqual({ ready: false, workers: "failing" });
		// A lost cache forgets the failure too: no evidence reads as starting.
		h.wipeCache();
		expect((await ready()).workers).toBe("starting");
	});
});

describe("the stateless relay's onboarding, on the cache", () => {
	it("redeems the owner's invitation once and serves the owner's policy view", async () => {
		const h = await openStatelessRelay();
		const start = () =>
			h.relay.handle(
				new Request(`${ORIGIN}/v1/app-bootstrap/start`, {
					method: "POST",
					headers: { authorization: `Bearer ${INVITATION}`, origin: ORIGIN },
				}),
			);
		const first = await start();
		expect(first.status).toBe(200);
		const owner =
			first.headers
				.getSetCookie()
				.find((entry) => entry.startsWith("__Host-hobo_ci_bootstrap="))
				?.split(";")[0] ?? "";
		expect((await start()).status).toBe(403);
		// The owner session stands for the onboarding control token on the
		// same-origin owner routes; nothing reaches the browser.
		const policy = await h.relay.handle(
			new Request(`${ORIGIN}/v1/accounts/self/policy`, {
				headers: {
					cookie: owner,
					origin: ORIGIN,
					"x-hobo-owner-control": "1",
				},
			}),
		);
		expect(policy.status).toBe(200);
		// App creation in the relay is gone: `hobo ci` creates the App.
		const create = await h.relay.handle(
			new Request(`${ORIGIN}/v1/app-bootstrap/callback?state=x&code=y`),
		);
		expect(create.status).toBe(410);
	});
});

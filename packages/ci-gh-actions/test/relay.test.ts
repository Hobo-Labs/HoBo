import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone } from "@bufbuild/protobuf";
import { OfferSchema } from "@hobo/ci";
import { afterEach, describe, expect, it } from "vitest";
import { LeaseStore } from "../src/store.js";
import { harness, job, NOW, queued, reserve, signed } from "./fixtures.js";

const stores: LeaseStore[] = [];
const apis: ReturnType<typeof harness>["api"][] = [];
function setup() {
	const h = harness();
	stores.push(h.store);
	apis.push(h.api);
	return h;
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const api of apis.splice(0)) expect(api.violations).toEqual([]);
});

it("rejects a host manually dispatched by another actor", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	h.api.host.actor = { id: 999 };
	await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(/untrusted/);
	h.api.host.status = "completed";
	await expect(h.relay.reconcile(lease.id, 22)).rejects.toThrow(/completion/);
	expect(h.store.get(lease.id)?.state).toBe("dispatched");
});
it("rejects a mismatched provider label", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	h.api.hostLabel = "wrong-provider";
	await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(/provider/);
	expect(h.api.registrations).toBe(0);
});
it("discovers and settles an uncertain host when its completion webhook was lost", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.api.uncertain = true;
	await h.relay.dispatchPending();
	h.api.host.status = "completed";
	await h.relay.discover(lease.id);
	expect(h.store.get(lease.id)).toMatchObject({
		state: "completed",
		hostRunId: 22,
	});
});
it.each([
	"github",
	"blacksmith",
	"depot",
	"warpbuild",
	"kubernetes",
])("dispatches a %s provider offer through its configured host label", async (provider) => {
	const h = setup();
	const account = h.configuration.accounts[0];
	if (!account) throw new Error("missing account");
	const offer = account.offers[0];
	if (!offer) throw new Error("missing offer");
	offer.provider = provider;
	offer.runsOn = `${provider}-host`;
	h.api.hostLabel = offer.runsOn;
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	expect(h.store.get(lease.id)).toMatchObject({
		provider,
		state: "dispatched",
	});
	expect(h.api.dispatches).toBe(1);
});

it("requeues displaced original demand after a host executed a different queued job", async () => {
	const h = setup();
	const lease = await reserve(h, 2);
	const waiting = signed(queued(1));
	await h.relay.webhook(waiting.body, waiting.signature, "workflow_job");
	await h.relay.dispatchPending();
	const finished = queued(1);
	finished.action = "completed";
	finished.workflow_job.runner_name = lease.runnerName;
	const request = signed(finished);
	await h.relay.webhook(request.body, request.signature, "workflow_job");
	h.api.host.status = "completed";
	await h.relay.reconcile(lease.id, 22);
	expect(h.store.pendingJobs().map((job) => job.id)).toEqual([2]);
	h.store.rebuild();
	expect(h.store.pendingJobs().map((job) => job.id)).toEqual([2]);
	h.api.strictLeaseId = false;
	await h.relay.dispatchPending();
	expect(h.store.all().filter((entry) => entry.jobId === 2)).toHaveLength(2);
	expect(h.api.dispatches).toBe(2);
});
it("does not launch expired free evidence after a reserved job waits", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.clock.now = "2026-10-27T00:00:00Z";
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
	expect(h.store.pendingJobs().map((job) => job.id)).toEqual([1]);
});
it("refuses stale free evidence after a long provider host queue", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	h.clock.now = "2026-10-27T00:00:00Z";
	await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(/unavailable/);
	expect(h.api.registrations).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("dispatched");
});

it("readmits a reserved free host when refreshed evidence has no remaining balance", async () => {
	const h = setup();
	const lease = await reserve(h);
	const offer = h.configuration.accounts[0]?.offers[0];
	if (!offer) throw new Error("missing offer");
	offer.freeMinutes = 0;
	offer.validUntil = "2026-11-01T00:00:00Z";
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
	expect(h.store.pendingJobs()).toHaveLength(1);
});
it("requeues an unlaunched reservation when a cheaper host becomes eligible", async () => {
	const h = setup();
	const account = h.configuration.accounts[0];
	const expensive = account?.offers[0];
	if (!account || !expensive) throw new Error("missing offer");
	expensive.freeMinutes = 0;
	const original = await reserve(h);
	const cheaper = clone(OfferSchema, expensive);
	cheaper.id = "github-cheaper";
	cheaper.provider = "github";
	cheaper.providerAccountId = "github-account";
	cheaper.runsOn = "ubuntu-24.04";
	cheaper.priceMicrosPerMinute = 1000;
	account.offers.push(cheaper);

	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(original.id)?.state).toBe("cancelled");
	expect(h.store.pendingJobs().map((entry) => entry.id)).toEqual([1]);

	h.api.strictLeaseId = false;
	h.api.hostLabel = cheaper.runsOn;
	await h.relay.dispatchPending();
	const replacement = h.store.all().find((entry) => entry.id !== original.id);
	expect(replacement).toMatchObject({
		offerId: cheaper.id,
		state: "dispatched",
	});
	expect(h.api.dispatches).toBe(1);
});
it("keeps the existing reservation when the new host costs the same", async () => {
	const h = setup();
	const account = h.configuration.accounts[0];
	const offer = account?.offers[0];
	if (!account || !offer) throw new Error("missing offer");
	offer.freeMinutes = 0;
	const original = await reserve(h);
	const equal = clone(OfferSchema, offer);
	equal.id = "equal";
	equal.providerAccountId = "another-account";
	account.offers.push(equal);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(1);
	expect(h.store.get(original.id)?.state).toBe("dispatched");
	expect(h.store.pendingJobs()).toHaveLength(0);
});
it("requeues an unlaunched paid host for partial free allocation under maximize-credits", async () => {
	const h = setup();
	const account = h.configuration.accounts[0];
	const offer = account?.offers[0];
	if (!account || !offer) throw new Error("missing offer");
	account.routingStrategy = "maximize-credits";
	offer.freeMinutes = 0;
	offer.priceMicrosPerMinute = 1;
	const original = await reserve(h);
	const free = clone(OfferSchema, offer);
	free.id = "partial-free";
	free.providerAccountId = "another-account";
	free.freeMinutes = 1;
	free.priceMicrosPerMinute = 1000;
	account.offers.push(free);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(original.id)?.state).toBe("cancelled");
	expect(h.store.pendingJobs()).toHaveLength(1);
	h.api.strictLeaseId = false;
	h.api.hostLabel = free.runsOn;
	await h.relay.dispatchPending();
	expect(h.store.all().find((entry) => entry.id !== original.id)).toMatchObject(
		{
			offerId: free.id,
			state: "dispatched",
		},
	);
});
it("reserves newly measured free minutes on the same unlaunched host", async () => {
	const h = setup();
	const offer = h.configuration.accounts[0]?.offers[0];
	if (!offer) throw new Error("missing offer");
	offer.freeMinutes = 0;
	const original = await reserve(h);
	offer.freeMinutes = 1;
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(original.id)?.state).toBe("cancelled");
	h.api.strictLeaseId = false;
	await h.relay.dispatchPending();
	expect(h.store.all().find((entry) => entry.id !== original.id)).toMatchObject(
		{
			offerId: offer.id,
			reservedFreeMinutes: 1,
			state: "dispatched",
		},
	);
});
it("does not reroute a dispatched host when a cheaper host appears", async () => {
	const h = setup();
	const account = h.configuration.accounts[0];
	const offer = account?.offers[0];
	if (!account || !offer) throw new Error("missing offer");
	offer.freeMinutes = 0;
	const original = await reserve(h);
	await h.relay.dispatchPending();
	const cheaper = clone(OfferSchema, offer);
	cheaper.id = "cheaper";
	cheaper.providerAccountId = "another-account";
	cheaper.priceMicrosPerMinute = 1;
	account.offers.push(cheaper);
	offer.freeMinutes = 1;
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(1);
	expect(h.store.get(original.id)?.state).toBe("dispatched");
	expect(h.store.pendingJobs()).toHaveLength(0);
});
it("does not extend a pinned free window merely because fresh evidence expires later", async () => {
	const h = setup();
	const lease = await reserve(h);
	const offer = h.configuration.accounts[0]?.offers[0];
	if (!offer) throw new Error("missing offer");
	offer.validUntil = "2026-11-01T00:00:00Z";
	h.clock.now = "2026-10-27T00:00:00Z";
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
});

it("does not settle a delayed host outside its pinned allocation window as free", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	h.api.host.status = "completed";
	h.api.host.run_started_at = "2026-10-26T23:58:00Z";
	h.api.host.updated_at = "2026-10-27T00:01:00Z";
	h.api.jobStatus = "completed";
	h.clock.now = h.api.host.updated_at;
	await h.relay.reconcile(lease.id, 22);
	expect(h.store.get(lease.id)).toMatchObject({
		state: "completed",
		billedMinutes: 3,
		billedFreeMinutes: 0,
		paidMicros: 12000,
	});
});

describe("signed GitHub intake and original job routing", () => {
	it("reserves the original job and dispatches a host without exposing JIT credentials", async () => {
		const h = setup();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(1);
		expect(h.store.get(lease.id)?.state).toBe("dispatched");
		expect(h.store.get(lease.id)?.originalRunId).toBe(11);
	});
	it("rejects modified webhook bytes and malformed signatures", async () => {
		const h = setup();
		const request = signed(queued());
		await expect(
			h.relay.webhook(Buffer.from("{}"), request.signature, "workflow_job"),
		).rejects.toThrow(/signature/);
		await expect(
			h.relay.webhook(request.body, "sha256=x", "workflow_job"),
		).rejects.toThrow(/signature/);
		expect(h.store.all()).toHaveLength(0);
	});
	it("deduplicates concurrent deliveries using the job identity", async () => {
		const h = setup();
		const request = signed(queued());
		await Promise.all(
			Array.from({ length: 8 }, () =>
				h.relay.webhook(request.body, request.signature, "workflow_job"),
			),
		);
		expect(h.store.all()).toHaveLength(1);
		expect(
			h.store.events().filter((event) => event.type === "ci.LeaseReserved"),
		).toHaveLength(1);
	});
	it("holds excess jobs in a durable queue and drains when capacity returns", async () => {
		const h = setup();
		const first = await reserve(h);
		const second = signed(queued(2));
		expect(
			await h.relay.webhook(second.body, second.signature, "workflow_job"),
		).toBe("waiting-for-budget-or-capacity");
		expect(h.store.pendingJobs().map((j) => j.id)).toEqual([2]);
		h.store.settle(first.id, 22, 1, NOW);
		h.api.strictLeaseId = false;
		await h.relay.dispatchPending();
		expect(h.store.all()).toHaveLength(2);
		expect(h.store.pendingJobs()).toHaveLength(0);
	});
	it.each([
		"fork",
		"public",
		"branch",
		"event",
		"installation",
		"repository",
		"label",
	])("refuses %s intake", async (condition) => {
		const h = setup();
		const payload = queued();
		if (condition === "fork") h.api.original.head_repository.id = 999;
		if (condition === "public") h.api.original.repository.private = false;
		if (condition === "branch") h.api.original.head_branch = "untrusted";
		if (condition === "event") h.api.original.event = "pull_request";
		if (condition === "installation") payload.installation.id = 999;
		if (condition === "repository") payload.repository.id = 999;
		if (condition === "label") payload.workflow_job.labels = ["hobo", "gpu"];
		const request = signed(payload);
		expect(
			await h.relay.webhook(request.body, request.signature, "workflow_job"),
		).toBe("ignored");
		expect(h.store.all()).toHaveLength(0);
	});
	it("does not resurrect terminal jobs from reordered queued events", async () => {
		const h = setup();
		const done = queued();
		done.action = "completed";
		const terminal = signed(done);
		await h.relay.webhook(terminal.body, terminal.signature, "workflow_job");
		const request = signed(queued());
		await h.relay.webhook(request.body, request.signature, "workflow_job");
		expect(h.store.all()).toHaveLength(0);
	});
	it("cancels unlaunched hosts when the queued job has already stopped", async () => {
		const h = setup();
		const lease = await reserve(h);
		h.api.jobStatus = "completed";
		await h.relay.dispatchPending();
		expect(h.store.get(lease.id)?.state).toBe("cancelled");
		expect(h.api.dispatches).toBe(0);
	});
	it("keeps uncertain launch reservations and never dispatches a duplicate", async () => {
		const h = setup();
		const lease = await reserve(h);
		h.api.uncertain = true;
		await h.relay.dispatchPending();
		await h.relay.dispatchPending();
		expect(h.store.get(lease.id)?.state).toBe("uncertain");
		expect(h.api.dispatches).toBe(1);
	});
});

describe("single-use identity-bound JIT runner leases", () => {
	it("binds claims to the pinned host and only registers one runner", async () => {
		const h = setup();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		expect(await h.relay.claim(lease.id, "valid")).toMatchObject({
			encodedJitConfig: "c2VjcmV0",
		});
		await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(
			/unavailable|claimed/,
		);
		expect(h.api.registrations).toBe(1);
		expect(JSON.stringify(h.store.events())).not.toContain("c2VjcmV0");
	});
	it.each([
		"repository",
		"sha",
		"run",
		"attempt",
		"workflow",
		"token",
	])("rejects wrong %s identity", async (condition) => {
		const h = setup();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		if (condition === "repository") h.identityClaims.repository_id = "202";
		if (condition === "sha") h.identityClaims.workflow_sha = "b".repeat(40);
		if (condition === "run") h.api.host.display_title = "HoBo lease other";
		if (condition === "attempt") h.identityClaims.run_attempt = "2";
		if (condition === "workflow")
			h.identityClaims.workflow_ref =
				"org/repo/.github/workflows/untrusted.yml@main";
		await expect(
			h.relay.claim(lease.id, condition === "token" ? "invalid" : "valid"),
		).rejects.toThrow();
		expect(h.api.registrations).toBe(0);
	});
	it("makes concurrent claims single-use", async () => {
		const h = setup();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		const results = await Promise.allSettled([
			h.relay.claim(lease.id, "valid"),
			h.relay.claim(lease.id, "valid"),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(h.api.registrations).toBe(1);
	});
	it("holds ambiguous registration state without minting again", async () => {
		const h = setup();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		h.api.invalidJit = true;
		await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow();
		await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow();
		expect(h.api.registrations).toBe(1);
		expect(h.store.get(lease.id)?.state).toBe("uncertain");
	});
});

describe("host billing and journal replay", () => {
	it("attributes the actual job by runner name and holds budget after original completion", async () => {
		const h = setup();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		const payload = queued(99);
		payload.action = "completed";
		payload.workflow_job.runner_name = lease.runnerName;
		const request = signed(payload);
		await h.relay.webhook(request.body, request.signature, "workflow_job");
		expect(h.store.get(lease.id)?.actualJobId).toBe(99);
		expect(h.store.get(lease.id)?.state).toBe("dispatched");
	});
	it("settles only a stopped verified host, rounds usage and preserves the reserved price", async () => {
		const h = setup();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		await h.relay.claim(lease.id, "valid");
		await expect(h.relay.reconcile(lease.id, 22)).rejects.toThrow(/completion/);
		h.api.host.status = "completed";
		h.api.host.updated_at = "2026-10-26T12:12:01Z";
		await h.relay.reconcile(lease.id, 22);
		await h.relay.reconcile(lease.id, 22);
		expect(h.store.get(lease.id)).toMatchObject({
			state: "completed",
			billedMinutes: 13,
			paidMicros: 12000,
		});
		expect(h.api.deletes).toBe(1);
	});
	it("does not release reservations until orphan runner cleanup succeeds", async () => {
		const h = setup();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		await h.relay.claim(lease.id, "valid");
		h.api.host.status = "completed";
		h.api.deleteStatus = 409;
		await expect(h.relay.reconcile(lease.id, 22)).rejects.toThrow(/cleanup/);
		expect(h.store.get(lease.id)?.state).toBe("running");
	});
	it("replays projections and recovers interrupted launch intents after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-ci-test-"));
		try {
			const h = harness(join(directory, "journal.sqlite"));
			const lease = await reserve(h);
			h.store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "dispatching";
				},
				"ci.DispatchRequested",
				NOW,
			);
			h.store.queue(job(2), NOW);
			const before = h.store.all();
			h.store.rebuild();
			expect(h.store.all()).toEqual(before);
			h.store.close();
			const reopened = new LeaseStore(join(directory, "journal.sqlite"));
			reopened.recover(NOW);
			expect(reopened.get(lease.id)?.state).toBe("uncertain");
			expect(reopened.pendingJobs()).toHaveLength(1);
			reopened.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

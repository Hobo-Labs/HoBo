import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	AccountSchema,
	type Configuration,
	ConfigurationSchema,
	ConnectionSchema,
	type Job,
	JobSchema,
	OfferSchema,
} from "../src/_generated/ci_pb.js";
import { SqliteCiStore } from "../src/sqlite-store.js";
import {
	isWebhookDeliveryId,
	MAX_WEBHOOK_ATTEMPTS,
	MAX_WEBHOOK_BYTES,
	parseWebhookEnvelope,
	type WebhookInput,
	webhookRetryDelayMs,
} from "../src/webhook-inbox.js";

const NOW = "2026-10-26T12:00:00Z";
const LATER = "2026-10-26T12:05:00Z";
const stores: SqliteCiStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

const BOX = create(OfferSchema, {
	id: "box",
	provider: "hobo-box-worker",
	providerAccountId: "worker",
	backend: "isolated-container",
	enabled: true,
	runsOn: "hobo-isolated-worker",
	concurrency: 2,
	observedAt: "2026-10-26T00:00:00Z",
	validUntil: "2030-01-01T00:00:00Z",
	sourceUrl: "https://example.test/evidence",
	bridgeAcknowledged: true,
	priceMicrosPerMinute: 0,
});

function configuration(extra: { box?: boolean } = {}): Configuration {
	return create(ConfigurationSchema, {
		accounts: [
			create(AccountSchema, {
				id: "account-a",
				budgetMicros: 1000000,
				maxRuntimeMinutes: 9,
				startupMinutes: 1,
				offers: [
					create(OfferSchema, {
						id: "hosted",
						provider: "blacksmith",
						providerAccountId: "owned-blacksmith-account",
						enabled: true,
						runsOn: "blacksmith-2vcpu-ubuntu-2404",
						freeMinutes: 10,
						priceMicrosPerMinute: 4000,
						budgetMicros: 1000000,
						concurrency: 2,
						observedAt: "2026-10-26T00:00:00Z",
						validUntil: "2026-10-27T00:00:00Z",
						sourceUrl: "https://example.test/usage",
						bridgeAcknowledged: true,
					}),
					...(extra.box ? [BOX] : []),
				],
			}),
		],
		connections: [
			create(ConnectionSchema, {
				accountId: "account-a",
				repository: "org/repo",
				repositoryId: 101,
				installationId: 10,
				bridgeWorkflow: "host.yml",
				bridgeSha: "a".repeat(40),
				runnerGroupId: 1,
				allowedEvents: ["push"],
				allowedRefs: ["refs/heads/main"],
				trustedRepositoryAcknowledged: true,
				bridgeRef: "hobo-ci-v1",
				dispatcherActorId: 123,
			}),
		],
	});
}

function job(
	id = 1,
	extra: {
		action?: string;
		repositoryId?: number;
		isolatedRequired?: boolean;
		queueDeadlineAt?: string;
	} = {},
): Job {
	return create(JobSchema, {
		id,
		runId: 11,
		runAttempt: 1,
		repositoryId: 101,
		installationId: 10,
		repository: "org/repo",
		labels: ["hobo"],
		action: "queued",
		...extra,
	});
}

async function configured(config = configuration()) {
	const store = new SqliteCiStore(":memory:");
	stores.push(store);
	await store.configure(config, 0, NOW);
	const account = (await store.configuration())?.configuration?.accounts[0];
	if (!account) throw new Error("account missing");
	return { store, account };
}

function delivery(
	deliveryId: string,
	body = `{"id":"${deliveryId}"}`,
	extra: Partial<WebhookInput> = {},
): WebhookInput {
	return {
		deliveryId,
		event: "workflow_job",
		installationId: 10,
		repositoryId: 101,
		rawBody: new TextEncoder().encode(body),
		receivedAt: NOW,
		...extra,
	};
}

describe("SqliteCiStore lease journal", () => {
	it("is ready and holds its configuration, records and policy snapshot", async () => {
		const { store } = await configured();
		expect(await store.ready()).toBe(true);
		expect((await store.configuration())?.revision).toBe(1);
		await store.putControlRecord(
			"ci-policy:account-a",
			"account-a",
			JSON.stringify({ status: "draft" }),
			NOW,
		);
		const snapshot = await store.policySnapshot();
		expect(snapshot.state?.revision).toBe(1);
		expect(snapshot.policies).toEqual([
			{ accountId: "account-a", bodyJson: JSON.stringify({ status: "draft" }) },
		]);
		expect((await store.controlRecord("ci-policy:account-a"))?.accountId).toBe(
			"account-a",
		);
		const state = await store.configureWithRecord(
			configuration(),
			1,
			NOW,
			"note:a",
			"account-a",
			JSON.stringify({ status: "kept" }),
		);
		expect(state.revision).toBe(2);
		expect((await store.controlRecord("note:a"))?.bodyJson).toContain("kept");
		await expect(store.configure(configuration(), 1, NOW)).rejects.toThrow(
			"configuration revision conflict",
		);
	});

	it("never moves a monotonic record back out of its terminal status", async () => {
		const { store } = await configured();
		const first = await store.putControlRecordMonotonic(
			"run:1",
			"account-a",
			JSON.stringify({ status: "running" }),
			NOW,
			"done",
		);
		expect(first?.bodyJson).toContain("running");
		await store.putControlRecordMonotonic(
			"run:1",
			"account-a",
			JSON.stringify({ status: "done" }),
			NOW,
			"done",
		);
		const late = await store.putControlRecordMonotonic(
			"run:1",
			"account-a",
			JSON.stringify({ status: "running" }),
			LATER,
			"done",
		);
		expect(late?.bodyJson).toContain("done");
		await expect(
			store.putControlRecordMonotonic(
				"run:1",
				"account-b",
				JSON.stringify({ status: "done" }),
				LATER,
				"done",
			),
		).rejects.toThrow("control record belongs to another account");
	});

	it("queues, reserves, transitions and settles a job with its journal", async () => {
		const { store, account } = await configured();
		const queued = job(1);
		await store.queue(queued, NOW, 1);
		expect(await store.pendingJobs()).toHaveLength(1);
		await expect(store.queue(job(2), NOW, 7)).rejects.toThrow(
			"configuration revision conflict",
		);
		const lease = await store.reserve(account, queued, NOW, 1);
		expect(lease?.state).toBe("reserved");
		expect(lease?.offerId).toBe("hosted");
		if (!lease) throw new Error("no lease");
		expect(await store.pendingJobs()).toHaveLength(0);
		expect((await store.reserve(account, queued, NOW))?.id).toBe(lease.id);
		expect((await store.activeLeases()).map((entry) => entry.id)).toEqual([
			lease.id,
		]);
		expect(await store.accountLeases("account-a")).toHaveLength(1);
		expect(await store.accountLeases("nobody")).toHaveLength(0);
		expect((await store.get(lease.id))?.id).toBe(lease.id);
		expect(await store.all()).toHaveLength(1);

		const dispatched = await store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "dispatching";
			},
			"ci.DispatchRequested",
			NOW,
			1,
		);
		expect(dispatched?.state).toBe("dispatching");
		expect(
			await store.transition(
				lease.id,
				["reserved"],
				() => {},
				"ci.DispatchRequested",
				NOW,
			),
		).toBeUndefined();
		const intents = await store.latestLeaseIntents([lease.id]);
		expect(intents.map((event) => event.type)).toEqual([
			"ci.DispatchRequested",
		]);
		expect(await store.latestLeaseIntents([])).toEqual([]);
		const events = await store.leaseEvents({
			accountId: "account-a",
			leaseId: lease.id,
			limit: 10,
		});
		expect(events.map((entry) => entry.event?.type)).toContain(
			"ci.LeaseReserved",
		);
		const head = await store.journalHead();
		expect(head).toBeGreaterThan(0);
		const page = await store.eventsSince({ accountId: "account-a", limit: 50 });
		expect(page.events.length).toBeGreaterThan(0);
		expect((await store.events()).length).toBeGreaterThan(0);

		const observed = await store.get(lease.id);
		if (!observed) throw new Error("lease vanished");
		expect(
			await store.settleObserved(lease.id, 77, 3, LATER, undefined, LATER, {
				state: "running",
				hostRunId: observed.hostRunId,
				runnerId: observed.runnerId,
			}),
		).toBeUndefined();
		const settled = await store.settleObserved(
			lease.id,
			77,
			3,
			LATER,
			undefined,
			LATER,
			{
				state: observed.state,
				hostRunId: observed.hostRunId,
				runnerId: observed.runnerId,
			},
		);
		expect(settled?.state).toBe("completed");
		expect(await store.settle(lease.id, 77, 3, LATER)).toBeUndefined();
		expect(await store.activeLeases()).toHaveLength(0);
	});

	it("cancels and requeues, withdraws and expires queued demand", async () => {
		const { store, account } = await configured(configuration({ box: true }));
		const queued = job(3, { isolatedRequired: true });
		await store.queue(queued, NOW);
		const lease = await store.reserve(account, queued, NOW);
		if (!lease) throw new Error("no lease");
		await store.cancelAndRequeue(lease.id, queued, NOW);
		expect((await store.get(lease.id))?.state).toBe("cancelled");
		expect(await store.pendingJobs()).toHaveLength(1);
		const again = await store.reserve(account, queued, NOW);
		if (!again) throw new Error("no second lease");
		expect(again.id).not.toBe(lease.id);
		expect(again.offerId).toBe("box");
		expect(await store.withdrawQueuedJob(queued, NOW, 1)).toBe(true);
		expect((await store.get(again.id))?.state).toBe("cancelled");

		const expiring = job(4, { queueDeadlineAt: "2026-10-26T12:01:00Z" });
		await store.queue(expiring, NOW);
		expect(await store.expireQueued(expiring, NOW, 1)).toBe(false);
		expect(await store.expireQueued(expiring, LATER, 1)).toBe(true);
		expect(await store.pendingJobs()).toHaveLength(0);

		const late = job(14, { queueDeadlineAt: "2026-10-26T12:01:00Z" });
		await store.queue(late, NOW);
		expect(await store.reserve(account, late, LATER)).toBeUndefined();
		expect(await store.pendingJobs()).toHaveLength(0);
	});

	it("observes a completed job and refuses to reserve it", async () => {
		const { store, account } = await configured();
		const done = job(5, { action: "completed" });
		await store.observe(done, NOW, 1);
		expect(await store.reserve(account, job(5), NOW)).toBeUndefined();
		expect(await store.assignedJob(job(5))).toBeUndefined();
		await expect(store.observe(done, NOW, 9)).rejects.toThrow(
			"configuration revision conflict",
		);
	});

	it("refuses to reserve for a revoked connection or account", async () => {
		const { store, account } = await configured();
		await expect(
			store.reserve(account, job(6, { repositoryId: 999 }), NOW),
		).rejects.toThrow("connection revoked");
		const stranger = create(AccountSchema, { ...account, id: "other" });
		await expect(store.reserve(stranger, job(6), NOW)).rejects.toThrow(
			"connection revoked",
		);
		await expect(store.reserve(account, job(6), NOW, 4)).rejects.toThrow(
			"configuration revision conflict",
		);
	});

	it("never places isolated work on a hosted offer", async () => {
		const { store, account } = await configured();
		const isolated = job(7, { isolatedRequired: true });
		await store.queue(isolated, NOW);
		expect(await store.reserve(account, isolated, NOW)).toBeUndefined();
		expect(await store.pendingJobs()).toHaveLength(1);

		const hosted = job(17);
		await store.queue(hosted, NOW);
		const lease = await store.reserve(account, hosted, NOW);
		if (!lease) throw new Error("no lease");
		expect(
			await store.reserve(account, job(17, { isolatedRequired: true }), NOW),
		).toBeUndefined();
		expect((await store.get(lease.id))?.state).toBe("cancelled");
		expect(await store.pendingJobs()).toHaveLength(2);
	});

	it("aborts an isolated reservation and puts the job back", async () => {
		const { store, account } = await configured(configuration({ box: true }));
		const queued = job(8, { isolatedRequired: true });
		await store.queue(queued, NOW);
		const lease = await store.reserve(account, queued, NOW);
		if (!lease) throw new Error("no lease");
		await store.abortIsolatedAndRequeue(lease.id, queued, NOW);
		expect((await store.get(lease.id))?.state).toBe("cancelled");
		expect(await store.pendingJobs()).toHaveLength(1);
	});

	it("clears no assignment for an active or unknown lease", async () => {
		const { store, account } = await configured();
		const queued = job(9);
		await store.queue(queued, NOW);
		const lease = await store.reserve(account, queued, NOW);
		if (!lease) throw new Error("no lease");
		expect(await store.clearAssignedJob(queued, lease.id, "v1", NOW, 1)).toBe(
			false,
		);
		expect(await store.clearAssignedJob(queued, "missing", "v1", NOW, 1)).toBe(
			false,
		);
		await expect(
			store.clearAssignedJob(queued, lease.id, "v1", NOW, 3),
		).rejects.toThrow("configuration revision conflict");
	});

	it("fails closed on shared-budget operations without an authority", async () => {
		const { store, account } = await configured();
		const queued = job(10);
		await store.queue(queued, NOW);
		const lease = await store.reserve(account, queued, NOW);
		if (!lease) throw new Error("no lease");
		await expect(
			store.reconcileSharedBudget(
				lease.id,
				0,
				{ usageEvidenceRef: "usage", sourceStoppedEvidenceRef: "stopped" },
				NOW,
			),
		).rejects.toThrow();
		await expect(
			store.releaseUnusedSharedBudget(lease.id, "proof", NOW),
		).rejects.toThrow("unused shared CI hold is not durably cancelled");
	});
});

describe("webhook envelope", () => {
	it("accepts only well-formed deliveries", () => {
		expect(isWebhookDeliveryId("abc-123")).toBe(true);
		expect(isWebhookDeliveryId("bad id")).toBe(false);
		const envelope = parseWebhookEnvelope(delivery("d1"));
		expect(envelope.receivedMs).toBe(Date.parse(NOW));
		expect(envelope.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(envelope.bodyHash).toMatch(/^[0-9a-f]{64}$/);
		for (const bad of [
			delivery("bad id"),
			delivery("d2", "{}", { event: "push" }),
			delivery("d3", "{}", { installationId: 0 }),
			delivery("d4", "{}", { repositoryId: -1 }),
			delivery("d5", "{}", { receivedAt: "not a time" }),
			{
				...delivery("d6"),
				rawBody: new Uint8Array(MAX_WEBHOOK_BYTES + 1),
			},
		])
			expect(() => parseWebhookEnvelope(bad)).toThrow(
				"invalid webhook envelope",
			);
	});

	it("backs off exponentially up to five minutes", () => {
		expect(webhookRetryDelayMs(1)).toBe(1000);
		expect(webhookRetryDelayMs(3)).toBe(4000);
		expect(webhookRetryDelayMs(20)).toBe(300000);
	});
});

describe("SqliteCiStore webhook inbox", () => {
	it("accepts, deduplicates and refuses conflicting deliveries", async () => {
		const { store } = await configured();
		expect(await store.hasWebhook("bad id")).toBe(false);
		expect(await store.hasWebhook("d1")).toBe(false);
		expect(await store.acceptWebhook(delivery("d1"))).toEqual({
			duplicate: false,
		});
		expect(await store.hasWebhook("d1")).toBe(true);
		expect(await store.acceptWebhook(delivery("d1"))).toEqual({
			duplicate: true,
		});
		await expect(
			store.acceptWebhook(delivery("d1", "different body")),
		).rejects.toThrow("conflicting webhook delivery id");
		expect(
			await store.acceptWebhook({
				...delivery("d2"),
				rawBody: delivery("d1").rawBody,
			}),
		).toEqual({ duplicate: true });
		await expect(store.acceptWebhook(delivery("bad id"))).rejects.toThrow(
			"invalid webhook envelope",
		);
		expect(await store.acceptIgnoredWebhook(delivery("d3"))).toEqual({
			duplicate: false,
		});
	});

	it("claims, acknowledges and releases a delivery under its token", async () => {
		const { store } = await configured();
		await store.acceptWebhook(delivery("d1"));
		await expect(store.claimWebhook("never", 5000)).rejects.toThrow(
			"invalid webhook claim",
		);
		await expect(store.claimWebhook(NOW, 10)).rejects.toThrow(
			"invalid webhook claim",
		);
		const claim = await store.claimWebhook(NOW, 5000);
		expect(claim?.deliveryId).toBe("d1");
		expect(new TextDecoder().decode(claim?.rawBody)).toBe('{"id":"d1"}');
		expect(await store.claimWebhook(NOW, 5000)).toBeUndefined();
		if (!claim) throw new Error("no claim");
		expect(await store.releaseWebhook("d1", "wrong")).toBe(false);
		expect(await store.releaseWebhook("d1", claim.token)).toBe(true);
		const second = await store.claimWebhook(NOW, 5000);
		if (!second) throw new Error("no second claim");
		expect(await store.ackWebhook("d1", second.token)).toBe(true);
		expect(await store.ackWebhook("d1", second.token)).toBe(false);
		expect(await store.claimWebhook(LATER, 5000)).toBeUndefined();
	});

	it("retries a failing delivery and quarantines it after the last attempt", async () => {
		const { store } = await configured();
		await store.acceptWebhook(delivery("d1"));
		await expect(store.failWebhook("d1", "t", "never")).rejects.toThrow(
			"invalid webhook failure time",
		);
		expect(await store.failWebhook("d1", "stale", NOW)).toBe("stale");
		let at = Date.parse(NOW);
		let outcome: string | undefined;
		for (let attempt = 1; attempt <= MAX_WEBHOOK_ATTEMPTS; attempt++) {
			const claim = await store.claimWebhook(new Date(at).toISOString(), 1000);
			if (!claim) throw new Error(`no claim on attempt ${attempt}`);
			outcome = await store.failWebhook(
				"d1",
				claim.token,
				new Date(at).toISOString(),
			);
			at += 10 * 60 * 1000;
		}
		expect(outcome).toBe("quarantined");
		const quarantined = await store.quarantinedWebhooks("account-a", 1);
		expect(quarantined).toEqual([
			expect.objectContaining({
				deliveryId: "d1",
				attempts: MAX_WEBHOOK_ATTEMPTS,
			}),
		]);
		expect(await store.quarantinedWebhooks("other", 1)).toEqual([]);
		await expect(store.quarantinedWebhooks("account-a", 5)).rejects.toThrow(
			"configuration revision conflict",
		);
		expect(await store.retryQuarantinedWebhook("other", 1, "d1")).toBe(false);
		expect(await store.retryQuarantinedWebhook("account-a", 1, "none")).toBe(
			false,
		);
		expect(await store.retryQuarantinedWebhook("account-a", 1, "d1")).toBe(
			true,
		);
		expect(
			(await store.claimWebhook(new Date(at).toISOString(), 1000))?.deliveryId,
		).toBe("d1");
	});

	it("quarantines an expired claim that has used every attempt", async () => {
		const { store } = await configured();
		await store.acceptWebhook(delivery("d1"));
		let at = Date.parse(NOW);
		for (let attempt = 1; attempt < MAX_WEBHOOK_ATTEMPTS; attempt++) {
			const claim = await store.claimWebhook(new Date(at).toISOString(), 1000);
			if (!claim) throw new Error(`no claim on attempt ${attempt}`);
			await store.failWebhook("d1", claim.token, new Date(at).toISOString());
			at += 10 * 60 * 1000;
		}
		expect(await store.claimWebhook(new Date(at).toISOString(), 1000)).toEqual(
			expect.objectContaining({ deliveryId: "d1" }),
		);
		at += 10 * 60 * 1000;
		expect(
			await store.claimWebhook(new Date(at).toISOString(), 1000),
		).toBeUndefined();
		expect(await store.quarantinedWebhooks("account-a", 1)).toHaveLength(1);
	});
});

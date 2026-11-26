import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { create, toJsonString } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	CiEventSchema,
	type Configuration,
	ConfigurationSchema,
	JobSchema,
	LeaseSchema,
	SandboxAllowanceSchema,
	SandboxPricingSchema,
} from "../src/_generated/ci_pb.js";
import { parseConfiguration } from "../src/config.js";
import { parsePipeline } from "../src/execution.js";
import { route } from "../src/routing.js";
import { LeaseStore } from "../src/store.js";

const NOW = "2026-10-27T12:00:00Z";
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function configuration() {
	const config = parseConfiguration(
		await readFile(
			new URL(
				"../data-models/fixtures/valid/configuration.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const a = config.accounts[0];
	const o = a?.offers[0];
	if (!a || !o) throw new Error("fixture missing");
	a.maxRuntimeMinutes = 1;
	a.startupMinutes = 1;
	a.budgetMicros = 100000;
	o.enabled = true;
	o.bridgeAcknowledged = true;
	o.observedAt = "2026-10-27T11:00:00Z";
	o.validUntil = "2026-10-28T12:00:00Z";
	o.budgetMicros = 100000;
	o.priceMicrosPerMinute = 1000;
	o.freeMinutes = 2;
	return config;
}
function clone(config: Configuration) {
	return parseConfiguration(toJsonString(ConfigurationSchema, config));
}
async function disk() {
	const path = await mkdtemp(join(tmpdir(), "hobo-ci-policy-"));
	directories.push(path);
	return join(path, "actor.sqlite");
}
function original() {
	return create(JobSchema, {
		id: 1,
		runId: 11,
		runAttempt: 1,
		repositoryId: 1,
		repository: "example/repository",
		installationId: 1,
		labels: ["hobo"],
		action: "queued",
	});
}

/** Seed authentic settled history, rather than changing a new GH lease's original payer. */
function historicalSandbox(paidMicros = 0) {
	const database = new DatabaseSync(":memory:");
	const store = new LeaseStore(":memory:", database);
	const job = original();
	const old = create(LeaseSchema, {
		id: "historical-sandbox",
		accountId: "example",
		offerId: "historical-vercel",
		provider: "vercel",
		providerAccountId: "vercel:historical",
		jobId: job.id,
		originalRunId: job.runId,
		runAttempt: job.runAttempt,
		repositoryId: job.repositoryId,
		repository: job.repository,
		installationId: job.installationId,
		runnerName: "hobo-historical-sandbox",
		state: "completed",
		sandboxStage: "stopped",
		runnerDeletionConfirmed: true,
		createdAt: NOW,
		settledAt: NOW,
		usageCompletedAt: NOW,
		paidMicros,
	});
	const body = toJsonString(LeaseSchema, old);
	database
		.prepare("INSERT INTO leases(id,job_key,body) VALUES(?,?,?)")
		.run(old.id, `${job.repositoryId}:${job.id}:${job.runAttempt}`, body);
	database.prepare("INSERT INTO events(body) VALUES(?)").run(
		toJsonString(CiEventSchema, {
			...create(CiEventSchema),
			type: "ci.HostSettled",
			accountId: old.accountId,
			leaseId: old.id,
			at: NOW,
			detail: body,
		}),
	);
	return { store, old };
}

describe("durable account policy and usage snapshots", () => {
	it("re-attests zero-credit Sandbox rates without advancing usage evidence", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const account = config.accounts[0];
			const offer = account?.offers[0];
			if (!account || !offer) throw new Error("fixture");
			offer.provider = "vercel";
			offer.backend = "sandbox";
			offer.freeMinutes = 0;
			offer.spentMicros = 4321;
			offer.validUntil = "2026-10-27T13:00:00Z";
			offer.sourceUrl = "https://vercel.com/docs/sandbox/pricing";
			offer.sandboxPricing = create(SandboxPricingSchema, {
				vcpus: 2,
				memoryMb: 4096,
				cpuMicrosPerVcpuHour: 1,
				memoryMicrosPerGbHour: 1,
				creationMicros: 1,
				maxEgressBytes: 10,
				egressMicrosPerGb: 1,
				proxyMicrosPerGb: 1,
				proxyFixedMicros: 1,
				bootstrapFixedMicros: 1,
				networkHeadroomBytes: 1,
			});
			store.configure(config, 0, NOW);
			const input = {
				accountId: account.id,
				offerId: offer.id,
				checkedAt: NOW,
				validUntil: "2026-10-28T12:00:00Z",
				sourceUrl: offer.sourceUrl,
			};
			const saved = store.reattestRate(input, 1, NOW);
			expect(saved.revision).toBe(2);
			const after = saved.configuration?.accounts[0]?.offers[0];
			expect(after?.observedAt).toBe(offer.observedAt);
			expect(after?.spentMicros).toBe(4321);
			expect(after?.validUntil).toBe(input.validUntil);
			expect(after?.sandboxPricing).toEqual(offer.sandboxPricing);
			const afterAccount = saved.configuration?.accounts[0];
			if (!afterAccount) throw new Error("missing saved account");
			const future = "2026-10-27T14:00:00Z";
			expect(route(afterAccount, [], future)).toBeDefined();
			const spent = create(LeaseSchema, {
				accountId: account.id,
				offerId: offer.id,
				state: "completed",
				paidMicros: account.budgetMicros,
				usageCompletedAt: NOW,
			});
			expect(route(afterAccount, [spent], future)).toBeUndefined();
			expect(store.events().at(-1)?.type).toBe("ci.RateReattested");
			expect(() => store.reattestRate(input, 1, NOW)).toThrow(
				/revision conflict/,
			);
			store.rebuild();
			expect(store.configuration()).toEqual(saved);
			const expired = "2026-10-28T13:00:00Z";
			const renewed = store.reattestRate(
				{ ...input, checkedAt: expired, validUntil: "2026-10-29T13:00:00Z" },
				2,
				expired,
			);
			expect(renewed.configuration?.accounts[0]?.offers[0]?.observedAt).toBe(
				offer.observedAt,
			);
		} finally {
			store.close();
		}
	});
	it("refuses stale, future, untrusted, free-credit or overly long attestations", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const account = config.accounts[0];
			const offer = account?.offers[0];
			if (!account || !offer) throw new Error("fixture");
			offer.provider = "vercel";
			offer.backend = "sandbox";
			offer.freeMinutes = 0;
			offer.validUntil = "2026-10-27T13:00:00Z";
			offer.sourceUrl = "https://vercel.com/docs/sandbox/pricing";
			offer.sandboxPricing = create(SandboxPricingSchema, {
				vcpus: 2,
				memoryMb: 4096,
				cpuMicrosPerVcpuHour: 1,
				memoryMicrosPerGbHour: 1,
				creationMicros: 1,
				maxEgressBytes: 10,
				egressMicrosPerGb: 1,
				proxyMicrosPerGb: 1,
				proxyFixedMicros: 1,
				bootstrapFixedMicros: 1,
				networkHeadroomBytes: 1,
			});
			store.configure(config, 0, NOW);
			const base = {
				accountId: account.id,
				offerId: offer.id,
				checkedAt: NOW,
				validUntil: "2026-10-28T12:00:00Z",
				sourceUrl: offer.sourceUrl,
			};
			for (const input of [
				{ ...base, accountId: "other" },
				{ ...base, sourceUrl: "https://example.com/" },
				{ ...base, checkedAt: "2026-10-27T12:00:01Z" },
				{ ...base, checkedAt: "2026-10-27T11:54:59Z" },
				{ ...base, validUntil: "2026-10-28T12:00:01Z" },
				{ ...base, validUntil: offer.validUntil },
			])
				expect(() => store.reattestRate(input, 1, NOW)).toThrow();
			const withCredit = clone(config);
			const credited = withCredit.accounts[0]?.offers[0];
			if (!credited) throw new Error("fixture");
			credited.sandboxAllowance = create(SandboxAllowanceSchema, {});
			credited.observedAt = "2026-10-27T12:00:01Z";
			store.configure(withCredit, 1, "2026-10-27T12:00:01Z");
			expect(() => store.reattestRate(base, 2, "2026-10-27T12:00:01Z")).toThrow(
				/attestation offer/,
			);
			expect(store.configuration()?.revision).toBe(2);
		} finally {
			store.close();
		}
	});
	it("atomically revisions policy and protobuf setup records, reopens and rebuilds both", async () => {
		const path = await disk();
		const config = await configuration();
		let store = new LeaseStore(path);
		try {
			const saved = store.configure(config, 0, NOW);
			expect(saved.revision).toBe(1);
			store.putControlRecord(
				"onboarding:request",
				"example",
				'{"id":"request","status":"planned"}',
				NOW,
			);
			expect(() => store.configure(config, 0, NOW)).toThrow(
				/revision conflict/,
			);
			expect(() =>
				store.putControlRecord("onboarding:request", "other", "{}", NOW),
			).toThrow(/another account/);
			store.close();
			store = new LeaseStore(path);
			store.rebuild();
			expect(store.configuration()).toEqual(saved);
			expect(store.controlRecord("onboarding:request")?.bodyJson).toBe(
				'{"id":"request","status":"planned"}',
			);
			expect(store.events().map((event) => event.type)).toEqual([
				"ci.ConfigurationChanged",
				"ci.ControlRecordUpdated",
			]);
		} finally {
			store.close();
		}
	});
	it("rejects destructive bridge/provider edits while a host holds a lease, but permits budget updates", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			store.configure(config, 0, NOW);
			const a = config.accounts[0];
			if (!a) throw new Error("fixture");
			const lease = store.reserve(a, original(), NOW);
			expect(lease).toBeDefined();
			const changed = clone(config);
			const c = changed.connections[0];
			if (!c) throw new Error("fixture");
			c.bridgeSha = "a".repeat(40);
			expect(() => store.configure(changed, 1, NOW)).toThrow(/active lease/);
			const isolated = clone(config);
			const isolatedConnection = isolated.connections[0];
			if (!isolatedConnection) throw new Error("fixture");
			isolatedConnection.isolatedOnly = true;
			isolatedConnection.acceptAllMatchingRepositoryJobs = true;
			isolatedConnection.publicRepositoryAcknowledged = true;
			isolatedConnection.allowedEvents = [];
			isolatedConnection.allowedRefs = [];
			isolatedConnection.bridgeWorkflow = "";
			isolatedConnection.bridgeSha = "";
			isolatedConnection.bridgeRef = "";
			isolatedConnection.dispatcherActorId = 0;
			expect(() => store.configure(isolated, 1, NOW)).toThrow(/active lease/);
			const changedProvider = clone(config);
			const o = changedProvider.accounts[0]?.offers[0];
			if (!o) throw new Error("fixture");
			o.providerAccountId = "another-provider-account";
			expect(() => store.configure(changedProvider, 1, NOW)).toThrow(
				/active lease/,
			);
			for (const broaden of [
				(connection: NonNullable<typeof c>) => {
					connection.allowAllPullRequests = true;
				},
				(connection: NonNullable<typeof c>) => {
					connection.allowedEvents.push("pull_request");
				},
				(connection: NonNullable<typeof c>) => {
					connection.allowedRefs.push("refs/heads/other");
				},
			]) {
				const expanded = clone(config);
				const connection = expanded.connections[0];
				if (!connection) throw new Error("fixture");
				broaden(connection);
				expect(() => store.configure(expanded, 1, NOW)).toThrow(/active lease/);
			}
			a.budgetMicros = 200000;
			expect(store.configure(config, 1, NOW).revision).toBe(2);
			expect(store.all()).toHaveLength(1);
			expect(
				store
					.events()
					.filter((event) => event.type === "ci.ConfigurationChanged"),
			).toHaveLength(2);
		} finally {
			store.close();
		}
	});
	it("never routes an isolated-only repository through the local workflow bridge", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const account = config.accounts[0];
			const connection = config.connections[0];
			if (!account || !connection) throw new Error("fixture");
			connection.isolatedOnly = true;
			connection.acceptAllMatchingRepositoryJobs = true;
			connection.publicRepositoryAcknowledged = true;
			connection.allowedEvents = [];
			connection.allowedRefs = [];
			connection.bridgeWorkflow = "";
			connection.bridgeSha = "";
			connection.bridgeRef = "";
			connection.dispatcherActorId = 0;
			store.configure(config, 0, NOW);
			expect(store.reserve(account, original(), NOW)).toBeUndefined();
		} finally {
			store.close();
		}
	});
	it("does not charge a refreshed inclusive snapshot twice when reconciliation arrives late", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const a = config.accounts[0];
			const o = a?.offers[0];
			if (!a || !o) throw new Error("fixture");
			o.freeMinutes = 0;
			store.configure(config, 0, NOW);
			const pipeline = parsePipeline(
				JSON.stringify({
					id: "build",
					accountId: a.id,
					timeoutSeconds: 60,
					steps: [{ id: "test", argv: ["true"] }],
				}),
			);
			const lease = store.reservePipeline(
				a,
				pipeline,
				"input-digest",
				[o.id],
				NOW,
			);
			if (!lease) throw new Error("fixture reservation");
			store.settle(lease.id, 0, 1, "2026-10-27T12:02:00Z", undefined, NOW);
			a.usageObservedAt = "2026-10-27T12:01:00Z";
			a.spentMicros = 1000;
			a.budgetMicros = 3000;
			o.observedAt = a.usageObservedAt;
			o.spentMicros = 1000;
			o.budgetMicros = 3000;
			store.configure(config, 1, "2026-10-27T12:03:00Z");
			expect(route(a, store.all(), "2026-10-27T12:03:00Z")?.paidMicros).toBe(
				2000,
			);
			expect(store.all()[0]?.usageCompletedAt).toBe(NOW);
		} finally {
			store.close();
		}
	});
	it("subtracts free usage only after the inclusive provider observation watermark", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const a = config.accounts[0];
			const o = a?.offers[0];
			if (!a || !o) throw new Error("fixture");
			store.configure(config, 0, NOW);
			const lease = store.reserve(a, original(), NOW);
			if (!lease) throw new Error("fixture reservation");
			store.settle(lease.id, 0, 1, "2026-10-27T12:02:00Z", undefined, NOW);
			o.freeMinutes = 1;
			o.observedAt = "2026-10-27T12:01:00Z";
			store.configure(config, 1, "2026-10-27T12:03:00Z");
			const decision = route(a, store.all(), "2026-10-27T12:03:00Z");
			expect(decision?.freeMinutes).toBe(1);
			expect(decision?.paidMicros).toBe(1000);
		} finally {
			store.close();
		}
	});
	it("settles an exact fractional free reservation after an inclusive snapshot without exceeding its cap", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const account = config.accounts[0];
			const offer = account?.offers[0];
			if (!account || !offer) throw new Error("fixture");
			account.maxRuntimeMinutes = 9;
			account.startupMinutes = 1;
			account.budgetMicros = 900;
			offer.budgetMicros = 900;
			offer.freeMinutes = 9.1;
			offer.priceMicrosPerMinute = 1000;
			store.configure(config, 0, NOW);
			const lease = store.reserve(account, original(), NOW);
			if (!lease) throw new Error("fixture reservation");
			expect(lease.reservedPaidMicros).toBe(900);
			account.usageObservedAt = "2026-10-27T12:20:00Z";
			account.spentMicros = 900;
			offer.observedAt = account.usageObservedAt;
			offer.freeMinutes = 0;
			offer.spentMicros = 900;
			store.configure(config, 1, "2026-10-27T12:21:00Z");
			const settled = store.settle(
				lease.id,
				0,
				10,
				"2026-10-27T12:30:00Z",
				undefined,
				"2026-10-27T12:10:00Z",
			);
			expect(settled).toMatchObject({
				billedFreeMinutes: 9.1,
				paidMicros: 900,
				usageCompletedAt: "2026-10-27T12:10:00Z",
			});
			expect(settled?.paidMicros).toBeLessThanOrEqual(lease.reservedPaidMicros);
			expect(
				route(account, store.all(), "2026-10-27T12:30:00Z"),
			).toBeUndefined();
		} finally {
			store.close();
		}
	});
	it("settles fractional billed duration exactly and rejects unsafe quantities atomically", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const account = config.accounts[0];
			const offer = account?.offers[0];
			if (!account || !offer) throw new Error("fixture");
			account.maxRuntimeMinutes = 9;
			account.startupMinutes = 1;
			offer.freeMinutes = 9.1;
			offer.priceMicrosPerMinute = 1000;
			const lease = store.reserve(account, original(), NOW);
			if (!lease) throw new Error("fixture reservation");
			expect(() =>
				store.settle(lease.id, 0, Number.MAX_SAFE_INTEGER + 1, NOW),
			).toThrow(/invalid settlement/);
			expect(() =>
				store.settle(lease.id, 0, Number.MAX_SAFE_INTEGER, NOW),
			).toThrow(/unsafe settlement cost/);
			expect(store.get(lease.id)?.state).toBe("reserved");
			const settled = store.settle(lease.id, 0, 9.35, NOW);
			expect(settled).toMatchObject({
				billedMinutes: 9.35,
				billedFreeMinutes: 9.1,
				paidMicros: 250,
			});
		} finally {
			store.close();
		}
	});
	it("persists budget signal ordering across reopen and rejects stale or discarded watermarks", async () => {
		const path = await disk();
		let store = new LeaseStore(path);
		try {
			const config = await configuration();
			const account = config.accounts[0];
			if (!account) throw new Error("fixture");
			const key = "broker:example:1";
			account.routingSignalCycles[key] = 1;
			account.routingSignalCrossed[key] = true;
			store.configure(config, 0, NOW);
			store.close();
			store = new LeaseStore(path);
			store.rebuild();
			expect(
				store.configuration()?.configuration?.accounts[0]?.routingSignalCycles[
					key
				],
			).toBe(1);
			const missing = clone(config);
			const missingAccount = missing.accounts[0];
			if (!missingAccount) throw new Error("fixture");
			delete missingAccount.routingSignalCycles[key];
			delete missingAccount.routingSignalCrossed[key];
			expect(() => store.configure(missing, 1, NOW)).toThrow(
				/watermark cannot move backwards/,
			);
			account.routingSignalCrossed[key] = false;
			expect(() => store.configure(config, 1, NOW)).toThrow(/newer cycle/);
			account.routingSignalCycles[key] = 2;
			expect(store.configure(config, 1, NOW).revision).toBe(2);
			expect(() =>
				store.configure(create(ConfigurationSchema), 2, NOW),
			).toThrow(/watermark cannot move backwards/);
			delete account.routingSignalCrossed[key];
			expect(() => store.configure(config, 2, NOW)).toThrow(
				/invalid routing signal state/,
			);
			expect(store.configuration()?.revision).toBe(2);
		} finally {
			store.close();
		}
	});
	it("refuses future and backwards usage watermarks without mutating its journal", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const a = config.accounts[0];
			if (!a) throw new Error("fixture");
			a.usageObservedAt = "2026-10-27T11:00:00Z";
			store.configure(config, 0, NOW);
			a.usageObservedAt = "2026-10-28T11:00:00Z";
			expect(() => store.configure(config, 1, NOW)).toThrow(/future/);
			a.usageObservedAt = "2026-10-26T11:00:00Z";
			expect(() => store.configure(config, 1, NOW)).toThrow(/backwards/);
			expect(store.configuration()?.revision).toBe(1);
			expect(store.events()).toHaveLength(1);
		} finally {
			store.close();
		}
	});
	it("requires newer provider and account observation facts and rejects future provider observations", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const account = config.accounts[0];
			const offer = account?.offers[0];
			if (!account || !offer) throw new Error("fixture");
			account.usageObservedAt = offer.observedAt;
			store.configure(config, 0, NOW);
			for (const field of [
				"freeMinutes",
				"priceMicrosPerMinute",
				"spentMicros",
			] as const) {
				const modified = clone(config);
				const changed = modified.accounts[0]?.offers[0];
				if (!changed) throw new Error("fixture");
				changed[field] += 1;
				expect(() => store.configure(modified, 1, NOW)).toThrow(
					/newer observation/,
				);
			}
			for (const field of ["validUntil", "sourceUrl"] as const) {
				const modified = clone(config);
				const changed = modified.accounts[0]?.offers[0];
				if (!changed) throw new Error("fixture");
				changed[field] =
					field === "validUntil"
						? "2026-10-29T12:00:00Z"
						: "https://example.com/new";
				expect(() => store.configure(modified, 1, NOW)).toThrow(
					/newer observation/,
				);
			}
			const modified = clone(config);
			if (!modified.accounts[0]) throw new Error("fixture");
			modified.accounts[0].spentMicros += 1;
			expect(() => store.configure(modified, 1, NOW)).toThrow(
				/newer observation/,
			);
			offer.observedAt = "2026-10-28T11:00:00Z";
			expect(() => store.configure(config, 1, NOW)).toThrow(/future provider/);
			offer.observedAt = "2026-10-27T11:01:00Z";
			offer.freeMinutes = 0;
			account.usageObservedAt = offer.observedAt;
			account.spentMicros = 1;
			expect(store.configure(config, 1, NOW).revision).toBe(2);
		} finally {
			store.close();
		}
	});
	it("records actual assignment, cancels only unlaunched duplicates, and retains markers during rebuild", async () => {
		const store = new LeaseStore(":memory:");
		try {
			const config = await configuration();
			const account = config.accounts[0];
			const offer = account?.offers[0];
			if (!account || !offer) throw new Error("fixture");
			offer.concurrency = 3;
			store.configure(config, 0, NOW);
			const first = store.reserve(account, original(), NOW);
			if (!first) throw new Error("first reservation");
			const otherJob = original();
			otherJob.id = 2;
			otherJob.runId = 12;
			const second = store.reserve(account, otherJob, NOW);
			if (!second) throw new Error("second reservation");
			store.transition(
				first.id,
				["reserved"],
				(entry) => {
					entry.state = "running";
				},
				"ci.RunnerStarted",
				NOW,
			);
			const assigned = original();
			assigned.id = 2;
			assigned.runId = 12;
			assigned.action = "in_progress";
			assigned.runnerName = first.runnerName;
			store.observe(assigned, NOW);
			expect(store.get(first.id)?.actualJobId).toBe(2);
			expect(store.get(second.id)?.state).toBe("cancelled");
			const before = store.assignedJob(otherJob);
			expect(before?.leaseId).toBe(first.id);
			expect(store.reserve(account, otherJob, NOW)).toBeUndefined();
			expect(
				store.clearAssignedJob(otherJob, first.id, before?.version ?? "", NOW),
			).toBe(false);
			store.observe(assigned, NOW);
			const current = store.assignedJob(otherJob);
			expect(current?.version).not.toBe(before?.version);
			const contradictory = original();
			contradictory.id = 3;
			contradictory.action = "in_progress";
			contradictory.runnerName = first.runnerName;
			expect(() => store.observe(contradictory, NOW)).toThrow(
				/assignment conflict/,
			);
			store.rebuild();
			expect(store.assignedJob(otherJob)).toEqual(current);
			store.settle(first.id, 0, 1, NOW);
			expect(
				store.clearAssignedJob(otherJob, first.id, before?.version ?? "", NOW),
			).toBe(false);
			expect(
				store.clearAssignedJob(otherJob, "wrong", current?.version ?? "", NOW),
			).toBe(false);
			expect(
				store.clearAssignedJob(otherJob, first.id, current?.version ?? "", NOW),
			).toBe(true);
			expect(store.reserve(account, otherJob, NOW)).toBeDefined();
			store.rebuild();
			expect(store.assignedJob(otherJob)).toBeUndefined();
		} finally {
			store.close();
		}
	});
	it("attributes late Sandbox events without disturbing a replacement reservation or assignment", async () => {
		const { store, old } = historicalSandbox(4321);
		try {
			const config = await configuration();
			const account = config.accounts[0];
			const offer = account?.offers[0];
			if (!account || !offer) throw new Error("fixture");
			offer.concurrency = 3;
			store.configure(config, 0, NOW);
			const job = original();
			job.id = 2;
			job.runId = 12;
			const replacement = store.reserve(account, job, NOW);
			if (!replacement) throw new Error("replacement reservation");
			const late = create(JobSchema, {
				...job,
				action: "in_progress",
				runnerName: old.runnerName,
			});
			store.observe(create(JobSchema, { ...late, installationId: 42 }), NOW);
			store.observe(
				create(JobSchema, { ...late, repository: "other/repository" }),
				NOW,
			);
			store.observe(create(JobSchema, { ...late, repositoryId: 42 }), NOW);
			expect(store.get(old.id)?.actualJobId).toBe(0);
			store.observe(late, NOW);
			expect(store.get(old.id)?.actualJobId).toBe(job.id);
			expect(store.get(old.id)?.paidMicros).toBe(4321);
			expect(store.get(replacement.id)?.state).toBe("reserved");
			expect(store.assignedJob(job)).toBeUndefined();
			store.transition(
				replacement.id,
				["reserved"],
				(lease) => {
					lease.state = "running";
				},
				"ci.RunnerStarted",
				NOW,
			);
			store.observe(
				create(JobSchema, { ...late, runnerName: replacement.runnerName }),
				NOW,
			);
			const assignment = store.assignedJob(job);
			expect(assignment?.leaseId).toBe(replacement.id);
			store.observe(late, NOW);
			expect(store.assignedJob(job)).toEqual(assignment);
			expect(() =>
				store.observe(create(JobSchema, { ...late, id: 3 }), NOW),
			).toThrow(/assignment conflict/);
			expect(store.get(old.id)?.paidMicros).toBe(4321);
		} finally {
			store.close();
		}
	});
	it("preserves pending demand and terminal tombstones on late Sandbox events", async () => {
		const { store, old } = historicalSandbox(1234);
		try {
			const config = await configuration();
			const account = config.accounts[0];
			if (!account) throw new Error("fixture");
			store.configure(config, 0, NOW);
			const job = create(JobSchema, { ...original(), id: 2, runId: 12 });
			store.queue(original(), NOW);
			store.queue(job, NOW);
			const late = create(JobSchema, {
				...job,
				action: "in_progress",
				runnerName: old.runnerName,
			});
			store.observe(late, NOW);
			expect(store.pendingJobs().map((entry) => entry.id)).toEqual([1, job.id]);
			store.rebuild();
			expect(store.pendingJobs().map((entry) => entry.id)).toEqual([1, job.id]);
			expect(store.assignedJob(job)).toBeUndefined();
			store.observe(create(JobSchema, { ...late, action: "completed" }), NOW);
			expect(store.pendingJobs().map((entry) => entry.id)).toEqual([1]);
			store.observe(late, NOW);
			store.queue(job, NOW);
			expect(store.pendingJobs().map((entry) => entry.id)).toEqual([1]);
			expect(store.assignedJob(job)).toBeUndefined();
			expect(store.get(old.id)?.actualJobId).toBe(job.id);
			expect(store.get(old.id)?.paidMicros).toBe(1234);
		} finally {
			store.close();
		}
	});
	it("cancels an unlaunched replacement when a settled runner's job is confirmed completed", async () => {
		const { store, old } = historicalSandbox(0);
		try {
			const config = await configuration();
			const account = config.accounts[0];
			const offer = account?.offers[0];
			if (!account || !offer) throw new Error("fixture");
			offer.concurrency = 2;
			store.configure(config, 0, NOW);
			const job = create(JobSchema, { ...original(), id: 2, runId: 12 });
			const replacement = store.reserve(account, job, NOW);
			if (!replacement) throw new Error("replacement reservation");
			store.observe(
				create(JobSchema, {
					...job,
					action: "completed",
					runnerName: old.runnerName,
				}),
				NOW,
			);
			expect(store.get(old.id)?.actualJobId).toBe(job.id);
			expect(store.get(replacement.id)?.state).toBe("cancelled");
			store.rebuild();
			expect(store.get(replacement.id)?.state).toBe("cancelled");
		} finally {
			store.close();
		}
	});
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	ConfigurationSchema,
	JobSchema,
	PipelineStepResultSchema,
} from "../src/_generated/ci_pb.js";
import { parseConfiguration } from "../src/config.js";
import { type PipelineBackend, parsePipeline } from "../src/execution.js";
import { PipelineScheduler } from "../src/scheduler.js";
import { LeaseStore } from "../src/store.js";

const NOW = "2026-10-27T12:00:00Z";
const LATER = "2026-10-27T12:01:00Z";
const stores: LeaseStore[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
function store(path = ":memory:") {
	const result = new LeaseStore(path);
	stores.push(result);
	return result;
}
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
	const account = config.accounts[0];
	const offer = account?.offers[0];
	if (!account || !offer) throw new Error("fixture missing account or offer");
	account.maxRuntimeMinutes = 1;
	account.startupMinutes = 1;
	account.budgetMicros = 1000;
	offer.budgetMicros = 1000;
	offer.priceMicrosPerMinute = 100;
	offer.freeMinutes = 0;
	offer.observedAt = "2026-10-27T11:00:00Z";
	offer.validUntil = "2026-10-28T00:00:00Z";
	offer.enabled = true;
	offer.bridgeAcknowledged = true;
	return { config, account, offer };
}
function pipeline(id = "build") {
	return parsePipeline(
		JSON.stringify({
			id,
			accountId: "example",
			timeoutSeconds: 30,
			steps: [{ id: "test", argv: ["true"] }],
		}),
	);
}
function job(id = 1, deadline = "") {
	return create(JobSchema, {
		id,
		runId: 10,
		runAttempt: 1,
		repositoryId: 1,
		repository: "example/repository",
		installationId: 1,
		action: "queued",
		queueDeadlineAt: deadline,
	});
}
function backend(open: () => void): PipelineBackend {
	return {
		kind: "gh-actions",
		capabilities: ["commands", "cancellation"],
		async open() {
			open();
			return {
				async run(step) {
					return create(PipelineStepResultSchema, { id: step.id });
				},
				async artifact() {
					throw new Error("no artifacts");
				},
				async close() {},
			};
		},
	};
}

describe("authoritative durable CI admission", () => {
	it("rechecks the committed cap and disabled offer instead of a stale scheduler account", async () => {
		const { config, account, offer } = await configuration();
		const s = store();
		s.configure(config, 0, NOW);
		const revoked = clone(ConfigurationSchema, config);
		const current = revoked.accounts[0];
		if (!current) throw new Error("fixture");
		current.budgetMicros = 0;
		s.configure(revoked, 1, NOW);
		expect(
			s.reservePipeline(account, pipeline(), "digest", [offer.id], NOW),
		).toBeUndefined();
		current.budgetMicros = 1000;
		const disabled = current.offers[0];
		if (!disabled) throw new Error("fixture");
		disabled.enabled = false;
		s.configure(revoked, 2, NOW);
		expect(
			s.reservePipeline(account, pipeline(), "digest", [offer.id], NOW),
		).toBeUndefined();
		expect(s.all()).toEqual([]);
	});
	it("sees policy revocation from another SQLite connection", async () => {
		const path = await mkdtemp(join(tmpdir(), "hobo-ci-authority-"));
		directories.push(path);
		const a = store(join(path, "authority.sqlite"));
		const b = store(join(path, "authority.sqlite"));
		const { config, account, offer } = await configuration();
		a.configure(config, 0, NOW);
		const changed = clone(ConfigurationSchema, config);
		const current = changed.accounts[0];
		if (!current) throw new Error("fixture");
		current.budgetMicros = 0;
		b.configure(changed, 1, NOW);
		expect(
			a.reservePipeline(account, pipeline(), "digest", [offer.id], NOW),
		).toBeUndefined();
	});
	it("checks policy again in the open microtask after reservation", async () => {
		const { config, account, offer } = await configuration();
		const s = store();
		s.configure(config, 0, NOW);
		let opens = 0;
		const scheduler = new PipelineScheduler(
			s,
			account.id,
			new Map([[offer.id, backend(() => opens++)]]),
			() => NOW,
		);
		const result = scheduler.execute(account, pipeline());
		const changed = clone(ConfigurationSchema, config);
		const current = changed.accounts[0];
		if (!current) throw new Error("fixture");
		current.budgetMicros = 0;
		s.configure(changed, 1, NOW);
		expect((await result).status).toBe("blocked");
		expect(opens).toBe(0);
		expect(s.all()[0]?.state).toBe("cancelled");
	});
	it("pins the native payer and refuses later lease identity mutation", async () => {
		const { config, account, offer } = await configuration();
		const s = store();
		s.configure(config, 0, NOW);
		const lease = s.reserve(account, job(), NOW);
		expect(lease?.providerAccountId).toBe(offer.providerAccountId);
		if (!lease) throw new Error("missing lease");
		expect(() =>
			s.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.providerAccountId = "foreign";
				},
				"ci.Forged",
				NOW,
			),
		).toThrow("immutable");
		expect(s.get(lease.id)?.providerAccountId).toBe(offer.providerAccountId);
	});
	it("preserves same-period account and provider spending watermarks after newer observations", async () => {
		const { config, account, offer } = await configuration();
		account.spentMicros = 300;
		offer.spentMicros = 300;
		account.usageObservedAt = offer.observedAt;
		const s = store();
		s.configure(config, 0, NOW);
		const changed = clone(ConfigurationSchema, config);
		const current = changed.accounts[0];
		const currentOffer = current?.offers[0];
		if (!current || !currentOffer) throw new Error("fixture");
		current.spentMicros = 0;
		current.usageObservedAt = NOW;
		currentOffer.spentMicros = 0;
		currentOffer.observedAt = NOW;
		expect(() => s.configure(changed, 1, NOW)).toThrow("watermark");
	});
	it("keeps removed offers' history across rebuild and requires fresh observation to revive", async () => {
		const { config, account, offer } = await configuration();
		const s = store();
		s.configure(config, 0, NOW);
		const removed = clone(ConfigurationSchema, config);
		const current = removed.accounts[0];
		if (!current) throw new Error("fixture");
		current.offers = [];
		s.configure(removed, 1, NOW);
		s.rebuild();
		expect(() => s.configure(config, 2, NOW)).toThrow("revival");
		offer.observedAt = LATER;
		s.configure(config, 2, LATER);
		expect(s.reserve(account, job(), LATER)?.providerAccountId).toBe(
			offer.providerAccountId,
		);
	});
	it("retains actual ordinary-runner overspend and emits one overrun event", async () => {
		const { config, account } = await configuration();
		const s = store();
		s.configure(config, 0, NOW);
		const lease = s.reserve(account, job(), NOW);
		if (!lease) throw new Error("missing lease");
		expect(s.settle(lease.id, 1, 20, LATER)?.paidMicros).toBe(2000);
		expect(
			s.events().filter((event) => event.type === "ci.BudgetOverrun"),
		).toHaveLength(1);
		expect(s.settle(lease.id, 1, 20, LATER)).toBeUndefined();
		expect(s.reserve(account, job(2), LATER)).toBeUndefined();
	});
	it("expires only untouched queued demand, persists tombstones and never releases uncertain holds", async () => {
		const { config, account } = await configuration();
		const s = store();
		s.configure(config, 0, NOW);
		const queued = job(1, LATER);
		s.queue(queued, NOW);
		expect(s.expireQueued(queued, NOW)).toBe(false);
		const lease = s.reserve(account, queued, NOW);
		if (!lease) throw new Error("missing lease");
		expect(s.expireQueued(queued, LATER)).toBe(true);
		s.rebuild();
		s.queue(queued, LATER);
		expect(s.pendingJobs()).toEqual([]);
		expect(s.get(lease.id)?.state).toBe("cancelled");
		const active = job(2, LATER);
		const held = s.reserve(account, active, NOW);
		if (!held) throw new Error("missing lease");
		s.transition(
			held.id,
			["reserved"],
			(entry) => {
				entry.state = "uncertain";
			},
			"ci.LeaseUncertain",
			NOW,
		);
		expect(s.expireQueued(active, LATER)).toBe(false);
		expect(s.get(held.id)?.state).toBe("uncertain");
	});
});

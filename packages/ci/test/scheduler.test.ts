import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { stableHash } from "@hobo/dispatcher";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Account,
	AccountSchema,
	JobSchema,
	OfferSchema,
	PipelineSchema,
	PipelineStepResultSchema,
} from "../src/_generated/ci_pb.js";
import {
	BackendUnavailableError,
	type PipelineBackend,
	parsePipeline,
} from "../src/execution.js";
import { PipelineScheduler } from "../src/scheduler.js";
import { LeaseStore } from "../src/store.js";

const NOW = "2026-10-26T12:00:00Z";
const stores: LeaseStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function offer(id: string, backend = "gh-actions", free = 0, price = 1000) {
	return create(OfferSchema, {
		id,
		backend,
		provider:
			backend === "cf"
				? "cloudflare"
				: backend === "dagger"
					? "dagger"
					: "github",
		providerAccountId: id,
		enabled: true,
		bridgeAcknowledged: true,
		runsOn: `${id}-host`,
		freeMinutes: free,
		priceMicrosPerMinute: price,
		budgetMicros: 1000000,
		concurrency: 1,
		observedAt: "2026-10-26T00:00:00Z",
		validUntil: "2026-11-01T00:00:00Z",
		sourceUrl: "https://example.test/usage",
	});
}
function account() {
	return create(AccountSchema, {
		id: "tenant",
		budgetMicros: 1000000,
		maxRuntimeMinutes: 9,
		startupMinutes: 1,
		offers: [
			offer("gh", "gh-actions", 2, 6000),
			offer("dag", "dagger", 2, 4000),
			offer("cf", "cf", 0, 1000),
		],
	});
}
function pipeline(id = "build", extra = {}) {
	return parsePipeline(
		JSON.stringify({
			id,
			accountId: "tenant",
			steps: [{ id: "test", argv: ["true"], cwd: ".", env: {} }],
			timeoutSeconds: 30,
			...extra,
		}),
	);
}
function backend(
	kind: PipelineBackend["kind"],
	calls: string[],
	mode = "ok",
): PipelineBackend {
	return {
		kind,
		capabilities: ["commands", "artifacts", "cancellation"],
		async open() {
			calls.push(kind);
			if (mode === "refused") throw new BackendUnavailableError();
			return {
				async run(step) {
					return create(PipelineStepResultSchema, {
						id: step.id,
						exitCode: 0,
						stdout: "same pipeline",
					});
				},
				async artifact() {
					throw new Error("no artifacts requested");
				},
				async close() {
					if (mode === "uncertain") throw new Error("unknown resource state");
				},
			};
		},
	};
}
function setup(a: Account = account(), kinds?: Map<string, PipelineBackend>) {
	const store = new LeaseStore(":memory:");
	stores.push(store);
	const calls: string[] = [];
	const bindings =
		kinds ??
		new Map([
			["gh", backend("gh-actions", calls)],
			["dag", backend("dagger", calls)],
			["cf", backend("cf", calls)],
		]);
	return {
		store,
		calls,
		scheduler: new PipelineScheduler(store, a.id, bindings, () => NOW),
		account: a,
		bindings,
	};
}

describe("persistent interchangeable pipeline scheduler", () => {
	it("rejects another tenant even when its offer IDs match bound contexts", async () => {
		const h = setup();
		const other = account();
		other.id = "another-tenant";
		await expect(
			h.scheduler.execute(other, pipeline("foreign", { accountId: other.id })),
		).rejects.toThrow("pipeline account mismatch");
		expect(h.calls).toEqual([]);
		expect(h.store.all()).toEqual([]);
	});
	it("uses free allocations before the cheapest paid backend", async () => {
		const h = setup();
		h.account.routingStrategy = "maximize-credits";
		expect(
			(await h.scheduler.execute(h.account, pipeline("first"))).backend,
		).toBe("dagger");
		expect(
			(await h.scheduler.execute(h.account, pipeline("second"))).backend,
		).toBe("gh-actions");
		// Each pipeline reserves two minutes and settles one. Consume the remaining
		// free minute on each initial backend before selecting the paid CF host.
		expect(
			(await h.scheduler.execute(h.account, pipeline("third"))).backend,
		).toBe("dagger");
		expect(
			(await h.scheduler.execute(h.account, pipeline("fourth"))).backend,
		).toBe("gh-actions");
		expect(
			(await h.scheduler.execute(h.account, pipeline("fifth"))).backend,
		).toBe("cf");
		expect(h.calls).toEqual([
			"dagger",
			"gh-actions",
			"dagger",
			"gh-actions",
			"cf",
		]);
		expect(h.store.all().every((lease) => lease.state === "completed")).toBe(
			true,
		);
	});
	it("never starts paid execution when the account budget is zero", async () => {
		const a = account();
		a.budgetMicros = 0;
		a.offers.forEach((o) => {
			o.freeMinutes = 0;
		});
		const h = setup(a);
		expect((await h.scheduler.execute(a, pipeline())).status).toBe("blocked");
		expect(h.calls).toEqual([]);
		expect(h.store.all()).toEqual([]);
	});
	it("filters incompatible free backends before ranking", async () => {
		const a = account();
		const h = setup(a);
		const existing = h.bindings.get("dag");
		if (!existing) throw new Error("fixture");
		h.bindings.set("dag", { ...existing, capabilities: ["commands"] });
		expect((await h.scheduler.execute(a, pipeline())).backend).toBe(
			"gh-actions",
		);
	});
	it("replays an identical completed execution without spending twice", async () => {
		const h = setup();
		const first = await h.scheduler.execute(h.account, pipeline());
		h.store.rebuild();
		const second = await h.scheduler.execute(h.account, pipeline());
		expect(second).toEqual(first);
		expect(h.calls).toHaveLength(1);
		expect(h.store.all()).toHaveLength(1);
	});
	it("reopens a durable completed execution and replays without launching", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-ci-restart-"));
		let store = new LeaseStore(join(directory, "ledger.sqlite"));
		const a = account();
		const calls: string[] = [];
		const bindings = new Map([["dag", backend("dagger", calls)]]);
		try {
			const first = await new PipelineScheduler(
				store,
				a.id,
				bindings,
				() => NOW,
			).execute(a, pipeline());
			const recorded = store.all();
			store.close();
			store = new LeaseStore(join(directory, "ledger.sqlite"));
			store.recover(NOW);
			const replay = await new PipelineScheduler(
				store,
				a.id,
				bindings,
				() => NOW,
			).execute(a, pipeline());
			expect(replay).toEqual(first);
			expect(store.all()).toEqual(recorded);
			expect(calls).toEqual(["dagger"]);
		} finally {
			store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("rejects reuse of the same id for different input", async () => {
		const h = setup();
		await h.scheduler.execute(h.account, pipeline());
		await expect(
			h.scheduler.execute(
				h.account,
				pipeline("build", { steps: [{ id: "different", argv: ["false"] }] }),
			),
		).rejects.toThrow(/different input/);
		expect(h.calls).toHaveLength(1);
	});
	it.each([
		"reserved",
		"running",
	])("recovers a durable %s native lease without replaying launch intent", async (state) => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-ci-intent-"));
		let store = new LeaseStore(join(directory, "ledger.sqlite"));
		const a = account();
		const p = pipeline();
		const calls: string[] = [];
		try {
			const lease = store.reservePipeline(
				a,
				p,
				stableHash(JSON.parse(toJsonString(PipelineSchema, p))),
				["dag"],
				NOW,
			);
			if (!lease) throw new Error("fixture reservation");
			if (state === "running")
				store.transition(
					lease.id,
					["reserved"],
					(entry) => {
						entry.state = "running";
					},
					"ci.PipelineStarted",
					NOW,
				);
			store.close();
			store = new LeaseStore(join(directory, "ledger.sqlite"));
			store.rebuild();
			store.recover(NOW);
			const scheduler = new PipelineScheduler(
				store,
				a.id,
				new Map([["dag", backend("dagger", calls)]]),
				() => NOW,
			);
			if (state === "reserved") {
				expect(store.get(lease.id)?.state).toBe("cancelled");
				expect((await scheduler.execute(a, p)).status).toBe("succeeded");
				expect(calls).toEqual(["dagger"]);
			} else {
				expect(store.get(lease.id)?.state).toBe("uncertain");
				await expect(scheduler.execute(a, p)).rejects.toThrow(/reconciliation/);
				expect(calls).toEqual([]);
			}
		} finally {
			store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("fails over only a definitive pre-allocation refusal", async () => {
		const h = setup();
		h.bindings.set("dag", backend("dagger", h.calls, "refused"));
		expect((await h.scheduler.execute(h.account, pipeline())).backend).toBe(
			"gh-actions",
		);
		expect(h.calls).toEqual(["dagger", "gh-actions"]);
		expect(
			h.store
				.all()
				.map((l) => l.state)
				.sort(),
		).toEqual(["cancelled", "completed"]);
	});
	it("does not fail over uncertain execution and keeps its reservation", async () => {
		const h = setup();
		h.bindings.set("dag", backend("dagger", h.calls, "uncertain"));
		expect((await h.scheduler.execute(h.account, pipeline())).status).toBe(
			"uncertain",
		);
		expect(h.calls).toEqual(["dagger"]);
		expect(h.store.all()[0]?.state).toBe("uncertain");
		await expect(h.scheduler.execute(h.account, pipeline())).rejects.toThrow(
			/reconciliation/,
		);
	});
	it("prevents cross-account execution and account timeout escalation", async () => {
		const h = setup();
		await expect(
			h.scheduler.execute(h.account, pipeline("build", { accountId: "other" })),
		).rejects.toThrow(/account/);
		await expect(
			h.scheduler.execute(
				h.account,
				pipeline("build", { timeoutSeconds: 1000 }),
			),
		).rejects.toThrow(/timeout/);
		expect(h.calls).toEqual([]);
	});
	it("shares account budget reservations between original Actions jobs and portable pipelines", async () => {
		const a = account();
		a.budgetMicros = 10000;
		a.offers = [
			offer("gh", "gh-actions", 0, 1000),
			offer("dag", "dagger", 0, 500),
		];
		const h = setup(a);
		const job = create(JobSchema, {
			id: 1,
			runId: 11,
			runAttempt: 1,
			repositoryId: 101,
			installationId: 10,
			repository: "org/repo",
			labels: ["hobo"],
			action: "queued",
		});
		const original = h.store.reserve(a, job, NOW);
		if (!original) throw new Error("fixture reservation");
		expect(original.offerId).toBe("gh");
		expect(original.reservedPaidMicros).toBe(10000);
		expect((await h.scheduler.execute(a, pipeline())).status).toBe("blocked");
		expect(h.calls).toEqual([]);
		h.store.transition(
			original.id,
			["reserved"],
			(entry) => {
				entry.state = "cancelled";
			},
			"ci.LeaseCancelled",
			NOW,
		);
		expect((await h.scheduler.execute(a, pipeline())).backend).toBe("dagger");
	});
	it("reserves free allocation atomically under concurrent calls", async () => {
		const a = account();
		a.budgetMicros = 0;
		a.offers = [offer("gh", "gh-actions", 2)];
		const calls: string[] = [];
		let release = () => {};
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const b = backend("gh-actions", calls);
		const open = b.open.bind(b);
		b.open = async (p, s) => {
			const session = await open(p, s);
			const run = session.run.bind(session);
			session.run = async (step, signal) => {
				await waiting;
				return run(step, signal);
			};
			return session;
		};
		const h = setup(a, new Map([["gh", b]]));
		const first = h.scheduler.execute(a, pipeline("first"));
		const second = await h.scheduler.execute(a, pipeline("second"));
		expect(second.status).toBe("blocked");
		release();
		expect((await first).status).toBe("succeeded");
		expect(calls).toEqual(["gh-actions"]);
	});
});

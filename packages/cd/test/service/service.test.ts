/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-conditional-empty-object-spread -- SAFETY: tests build generated records with create(), brand ids they mint, and swap one fake method in place. */
// WP12 Accept: readiness flips on store loss; drain completes within the
// deadline; the service ticks every module (incl. inventory, fan-out,
// failover and posture); drain releases leases.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { RetentionPolicyRecordSchema } from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS } from "../../src/events.js";
import type { CdFactories } from "../../src/ports.js";
import {
	CD_SERVICE_STEPS,
	CdServiceError,
	createCdService,
} from "../../src/service/index.js";
import {
	fakeFacade,
	fakeReconciler,
	fakeStore,
	principal,
	recordingSink,
} from "./fakes.js";

function setup(
	over: Partial<{
		tickIntervalMs: number;
		retentionIntervalMs: number;
		stepTimeoutMs: number;
	}> = {},
) {
	const store = fakeStore();
	const cd = fakeFacade();
	const sink = recordingSink();
	const reconcilers = [
		fakeReconciler("r1", ["eu-1", "eu-2"]),
		fakeReconciler("r2", ["us-1"]),
	];
	let now = 1_700_000_000_000;
	const service = createCdService({
		store,
		tenant: "t1",
		now: () => now,
		cd,
		reconcilers,
		retention: [
			create(RetentionPolicyRecordSchema, { bindle: "shop", keepPerCamp: 5 }),
		],
		tickIntervalMs: over.tickIntervalMs ?? 60_000,
		principal,
		telemetry: sink,
		reconcilerBackoff: { baseMs: 15, maxMs: 60 },
		...(over.retentionIntervalMs === undefined
			? {}
			: { retentionIntervalMs: over.retentionIntervalMs }),
		...(over.stepTimeoutMs === undefined
			? {}
			: { stepTimeoutMs: over.stepTimeoutMs }),
	});
	return {
		store,
		cd,
		sink,
		reconcilers,
		service,
		advance(ms: number) {
			now += ms;
		},
	};
}

const deadline = (ms: number) => AbortSignal.timeout(ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createCdService — tick loop", () => {
	it("ticks every module in a fixed order, including inventory, fan-out, failover and posture", async () => {
		const { service, cd } = setup();
		const report = await service.tick();
		expect(report.steps.map((s) => s.step)).toEqual([...CD_SERVICE_STEPS]);
		expect(CD_SERVICE_STEPS).toEqual([
			"sources",
			"inventory",
			"pipelines",
			"promotions",
			"verification",
			"rollouts",
			"fanout",
			"failover",
			"posture",
			"previews",
			"retention",
		]);
		expect(cd.calls.filter((c) => c !== "inventory.list")).toEqual([
			...CD_SERVICE_STEPS,
		]);
		expect(report.steps.every((s) => s.ok)).toBe(true);
	});

	it("isolates a failing step: the rest of the tick still runs and the failure is visible", async () => {
		const { service, cd, sink } = setup();
		cd.failStep("pipelines", new Error("pipeline fold exploded"));
		const report = await service.tick();
		const failed = report.steps.find((s) => s.step === "pipelines");
		expect(failed?.ok).toBe(false);
		expect(failed?.reason?.code).toBe("step-failed");
		expect(failed?.reason?.remediation).toMatch(/runbook/);
		expect(cd.calls).toContain("posture");
		expect(cd.calls).toContain("retention");
		expect(
			sink.points.some(
				(p) =>
					p.name === "hobo.cd.service.step_failures" &&
					p.attributes.step === "pipelines",
			),
		).toBe(true);
		const check = service
			.health()
			.checks.find((c) => c.name === "step:pipelines");
		expect(check?.ok).toBe(false);
		expect(check?.detail).toContain("pipeline fold exploded");
	});

	it("runs retention once per retention interval, not every tick", async () => {
		const { service, cd, advance } = setup({ retentionIntervalMs: 3_600_000 });
		await service.tick();
		await service.tick();
		expect(cd.retired).toHaveLength(1);
		advance(3_600_000);
		await service.tick();
		expect(cd.retired).toHaveLength(2);
	});

	it("does not stack a hung step: past its deadline it is reported and skipped until it settles", async () => {
		const { service, cd } = setup({ stepTimeoutMs: 20 });
		cd.hangStep("fanout");
		const first = await service.tick();
		expect(first.steps.find((s) => s.step === "fanout")?.reason?.code).toBe(
			"step-failed",
		);
		expect(cd.calls.filter((c) => c === "posture")).toHaveLength(1);
		const second = await service.tick();
		expect(second.steps.find((s) => s.step === "fanout")?.skipped).toBe(true);
		expect(cd.calls.filter((c) => c === "fanout")).toHaveLength(1);
	});

	it("uses the frozen default tick interval constant", () => {
		expect(CD_DEFAULTS.serviceTickMs).toBe(1_000);
	});

	it("implements the frozen CdFactories.createCdService signature", () => {
		const factory: CdFactories["createCdService"] = createCdService;
		expect(factory).toBe(createCdService);
	});

	it("drives ticks on its own timer after start", async () => {
		const { service, cd } = setup({ tickIntervalMs: 5 });
		await service.start();
		await sleep(60);
		await service.drain(deadline(1_000));
		expect(cd.calls.filter((c) => c === "sources").length).toBeGreaterThan(2);
	});
});

describe("createCdService — readiness", () => {
	it("is ready after start with a healthy store, running reconcilers and healthy sources", async () => {
		const { service } = setup();
		expect(service.ready()).toBe(false);
		await service.start();
		expect(service.ready()).toBe(true);
		expect(service.health().ok).toBe(true);
		await service.drain(deadline(1_000));
	});

	it("readiness flips on store loss and back on recovery", async () => {
		const { service, store, cd, sink } = setup();
		await service.start();
		expect(service.ready()).toBe(true);
		store.lose();
		const report = await service.tick();
		expect(report.store).toBe(false);
		expect(service.ready()).toBe(false);
		const check = service.health().checks.find((c) => c.name === "store");
		expect(check).toMatchObject({ ok: false });
		expect(check?.detail).toMatch(/journal unreachable/);
		// No module steps run against a lost journal.
		const before = cd.calls.length;
		await service.tick();
		expect(cd.calls.length).toBe(before);
		expect(
			sink.points.some(
				(p) => p.name === "hobo.cd.service.ready" && p.value === 0,
			),
		).toBe(true);
		store.restore();
		await service.tick();
		expect(service.ready()).toBe(true);
		await service.drain(deadline(1_000));
	});

	it("a step that fails with a persistence error also marks the store down", async () => {
		const { service, cd } = setup();
		await service.start();
		const { PersistenceUnavailableError } = await import("@hobo/core");
		cd.failStep("promotions", new PersistenceUnavailableError("write failed"));
		await service.tick();
		expect(service.ready()).toBe(false);
		await service.tick();
		expect(service.ready()).toBe(true);
		await service.drain(deadline(1_000));
	});

	it("readiness reflects source health", async () => {
		const { service, cd } = setup();
		await service.start();
		cd.failStep("sources", new Error("registry unreachable"));
		await service.tick();
		expect(service.ready()).toBe(false);
		expect(
			service.health().checks.find((c) => c.name === "step:sources")?.ok,
		).toBe(false);
		await service.tick();
		expect(service.ready()).toBe(true);
		await service.drain(deadline(1_000));
	});

	it("readiness reflects reconciler leases: a crashed run loop is not ready until restarted", async () => {
		const { service, reconcilers, sink } = setup();
		const r1 = reconcilers[0];
		if (!r1) throw new Error("fixture");
		r1.crashNext(new Error("lease store refused"));
		await service.start();
		expect(service.ready()).toBe(false);
		const check = service
			.health()
			.checks.find((c) => c.name === "reconciler:r1");
		expect(check?.ok).toBe(false);
		expect(check?.detail).toMatch(/lease store refused/);
		await sleep(80);
		expect(r1.runs).toBe(2);
		expect(service.ready()).toBe(true);
		expect(
			sink.points.some((p) => p.name === "hobo.cd.service.reconciler_restarts"),
		).toBe(true);
		await service.drain(deadline(1_000));
	});

	it("is not ready while draining or after drain", async () => {
		const { service } = setup();
		await service.start();
		await service.drain(deadline(1_000));
		expect(service.ready()).toBe(false);
	});

	it("refuses a second start with a typed error", async () => {
		const { service } = setup();
		await service.start();
		await expect(service.start()).rejects.toMatchObject({
			code: "already-started",
		});
		await expect(service.start()).rejects.toBeInstanceOf(CdServiceError);
		await service.drain(deadline(1_000));
	});
});

describe("createCdService — drain", () => {
	it("drain releases every reconciler lease and stops ticking", async () => {
		const { service, reconcilers, cd } = setup({ tickIntervalMs: 5 });
		await service.start();
		expect(reconcilers.every((r) => r.leases.size > 0)).toBe(true);
		await service.drain(deadline(1_000));
		expect(reconcilers.every((r) => r.leases.size === 0)).toBe(true);
		const after = cd.calls.length;
		await sleep(30);
		expect(cd.calls.length).toBe(after);
		expect(
			service.health().checks.find((c) => c.name === "drain"),
		).toMatchObject({ ok: true });
	});

	it("drain completes within the deadline even when a reconciler is wedged", async () => {
		const { service, reconcilers, sink } = setup();
		reconcilers[1]?.wedge();
		await service.start();
		const started = Date.now();
		await service.drain(deadline(50));
		const took = Date.now() - started;
		expect(took).toBeLessThan(500);
		const check = service.health().checks.find((c) => c.name === "drain");
		expect(check?.ok).toBe(false);
		expect(check?.detail).toContain("drain-deadline-exceeded");
		expect(
			sink.points.some(
				(p) =>
					p.name === "hobo.cd.service.drain_ms" &&
					p.attributes.completed === false,
			),
		).toBe(true);
	});

	it("drain waits for the in-flight tick to finish before returning", async () => {
		const { service, cd } = setup({ stepTimeoutMs: 10_000 });
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		(cd.posture as unknown as { tick: () => Promise<void> }).tick =
			async () => {
				cd.calls.push("posture");
				await gate;
			};
		const tick = service.tick();
		let drained = false;
		const drain = service.drain(deadline(1_000)).then(() => {
			drained = true;
		});
		await sleep(10);
		expect(drained).toBe(false);
		release();
		await tick;
		await drain;
		expect(drained).toBe(true);
	});

	it("drain before start is a no-op", async () => {
		const { service } = setup();
		await service.drain(deadline(100));
		expect(service.ready()).toBe(false);
	});
});

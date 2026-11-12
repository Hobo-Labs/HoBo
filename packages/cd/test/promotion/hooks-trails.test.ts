// Hook runner (hooks.ts) and Trails adapter (trails.ts) unit behaviour.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { FreightRecordSchema, HookKind, HookPoint, type HookRecord, HookRecordSchema } from "../../src/_generated/cd_pb.js";
import { createHookRunner, HOOK_REASON } from "../../src/adapters/hooks.js";
import { createTrailsMigrations, type DataMigrationRun, MIGRATION_LABEL, TRAILS_REASON } from "../../src/adapters/trails.js";
import { FakeNotify, FakeRunbooks, FakeSuites, RecordingTelemetry } from "./doubles.js";
import { camp, context, fid, T0 } from "./store.js";

const subject = { promotionId: "promo_1", campId: camp("dev-1"), freightId: fid("f1"), pipeline: "shop", node: "dev" };
const hook = (kind: HookKind, point: HookPoint, ref: string): HookRecord => create(HookRecordSchema, { kind, point, ref });

function runner() {
	const runbooks = new FakeRunbooks();
	const suites = new FakeSuites();
	const notify = new FakeNotify();
	const telemetry = new RecordingTelemetry();
	return { runbooks, suites, notify, telemetry, hooks: createHookRunner({ runbooks, suites, notify, telemetry }) };
}

describe("hook runner", () => {
	it("runs only the hooks of the point, in order, passing the promotion subject", async () => {
		const r = runner();
		const result = await r.hooks.run(
			{
				hooks: [hook(HookKind.RUNBOOK, HookPoint.BEFORE_APPLY, "a.json"), hook(HookKind.SUITE, HookPoint.AFTER_CONVERGED, "smoke"), hook(HookKind.RUNBOOK, HookPoint.BEFORE_APPLY, "b.json")],
				point: HookPoint.BEFORE_APPLY,
				subject,
			},
			context(() => T0),
		);
		expect(result).toEqual({ ok: true, value: 2 });
		expect(r.runbooks.runs.map((run) => run.path)).toEqual(["a.json", "b.json"]);
		expect(r.runbooks.runs[0]?.args).toMatchObject({ promotionId: "promo_1", campId: "dev-1", point: "before-apply" });
		expect(r.suites.runs).toEqual([]);
		expect(r.telemetry.named("hobo.cd.hook.run")).toHaveLength(2);
	});

	it("stops a forward point at the first failure; ON_FAILURE runs every hook and never fails", async () => {
		const r = runner();
		r.runbooks.failing.add("a.json");
		const forward = await r.hooks.run({ hooks: [hook(HookKind.RUNBOOK, HookPoint.AFTER_QUALIFIED, "a.json"), hook(HookKind.RUNBOOK, HookPoint.AFTER_QUALIFIED, "b.json")], point: HookPoint.AFTER_QUALIFIED, subject }, context(() => T0));
		expect(forward.ok).toBe(false);
		if (!forward.ok) expect(forward.reasons[0]?.code).toBe(HOOK_REASON.runbookFailed);
		expect(r.runbooks.runs.map((run) => run.path)).toEqual(["a.json"]);
		const failure = await r.hooks.run({ hooks: [hook(HookKind.RUNBOOK, HookPoint.ON_FAILURE, "a.json"), hook(HookKind.NOTIFY, HookPoint.ON_FAILURE, "ops")], point: HookPoint.ON_FAILURE, subject }, context(() => T0));
		expect(failure.ok).toBe(true);
		expect(r.notify.sent.map((s) => s.channel)).toEqual(["ops"]);
	});

	it("NOTIFY is best-effort; an unknown kind fails the point", async () => {
		const r = runner();
		r.notify.notify = async () => {
			throw new Error("endpoint down");
		};
		expect((await r.hooks.run({ hooks: [hook(HookKind.NOTIFY, HookPoint.AFTER_QUALIFIED, "ops")], point: HookPoint.AFTER_QUALIFIED, subject }, context(() => T0))).ok).toBe(true);
		const unknown = await r.hooks.run({ hooks: [hook(HookKind.UNSPECIFIED, HookPoint.AFTER_QUALIFIED, "?")], point: HookPoint.AFTER_QUALIFIED, subject }, context(() => T0));
		expect(unknown.ok).toBe(false);
	});
});

describe("Trails adapter", () => {
	const freight = create(FreightRecordSchema, { freightId: "f1", manifest: { labels: { [MIGRATION_LABEL]: "orders-v2" } } });

	it("reads the migration from the Freight label by default", async () => {
		const trails = createTrailsMigrations({ execute: async () => ({ status: "completed", dualWindowOpen: false, blockedReasons: [] }) });
		expect(await trails.migrationFor({ freight, campId: camp("dev-1") })).toEqual({ migrationId: "orders-v2" });
		expect(await trails.migrationFor({ freight: create(FreightRecordSchema, { freightId: "f2", manifest: {} }), campId: camp("dev-1") })).toBeUndefined();
	});

	it("expand succeeds with the dual window open; contract needs completed; holds and failures are typed", async () => {
		let next: DataMigrationRun = { status: "contract-blocked", dualWindowOpen: true, blockedReasons: ["worker@1 on legacy"] };
		const trails = createTrailsMigrations({ execute: async () => next });
		const ctx = context(() => T0);
		expect((await trails.run({ migrationId: "m", campId: camp("dev-1"), phase: "expand" }, ctx)).ok).toBe(true);
		const contract = await trails.run({ migrationId: "m", campId: camp("dev-1"), phase: "contract" }, ctx);
		expect(contract.ok).toBe(false);
		if (!contract.ok) expect(contract.reasons[0]?.code).toBe(TRAILS_REASON.held);
		next = { status: "failed", dualWindowOpen: false, blockedReasons: [] };
		const failed = await trails.run({ migrationId: "m", campId: camp("dev-1"), phase: "expand" }, ctx);
		expect(!failed.ok && failed.reasons[0]?.code).toBe(TRAILS_REASON.failed);
		const throwing = createTrailsMigrations({
			execute: async () => {
				throw new Error("store offline");
			},
		});
		const error = await throwing.run({ migrationId: "m", campId: camp("dev-1"), phase: "expand" }, ctx);
		expect(!error.ok && error.reasons[0]?.code).toBe(TRAILS_REASON.error);
	});
});

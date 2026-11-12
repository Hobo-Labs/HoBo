// WP6 Accept bullets and §10 rows for the promotion saga.
import { describe, expect, it } from "vitest";
import {
	ChangeKind,
	HookKind,
	HookPoint,
	PromotionState,
	SetOrigin,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS, LINEAGE_UNSATISFIED, WINDOW_CLOSED } from "../../src/events.js";
import { PROMOTION_METRIC, PROMOTION_REASON, STEP } from "../../src/promotion/index.js";
import { pipelineNode, resolvedFor } from "./doubles.js";
import { harness } from "./harness.js";
import { AGENT, APPROVER, camp, fid, HOUR, MINUTE } from "./store.js";

function withPipeline(h: ReturnType<typeof harness>) {
	h.pipelines.define("shop", [
		pipelineNode("staging", { campIds: ["staging-1", "staging-2"] }),
		pipelineNode("prod", { campIds: ["prod-1", "prod-2"], fromNodes: ["staging"] }),
	]);
}

describe("promotion saga (WP6)", () => {
	it("I1 across two providers: the same Freight reaches both Camps unrebuilt and the infrastructure diff is shown", async () => {
		const h = harness();
		withPipeline(h);
		h.freight.add("f1");
		h.pipelines.makeAvailable("shop", "prod", "f1");
		h.resolver.providers.set("prod-1", "alpha");
		h.resolver.providers.set("prod-2", "beta");
		h.desired.seed("staging-1", "f1", resolvedFor("staging-1", "alpha", "f1"));
		const result = await h.service.promote(
			{ freightId: fid("f1"), targets: [camp("prod-1"), camp("prod-2")], idempotencyKey: "k1", pipeline: "shop", node: "prod", sourceCampId: camp("staging-1") },
			h.ctx(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state).toBe(PromotionState.PROMOTED);
		const a = await h.desired.current(camp("prod-1"));
		const b = await h.desired.current(camp("prod-2"));
		expect(a?.freightId).toBe("f1");
		expect(b?.freightId).toBe("f1");
		// Same Freight, same declaration (plan objective carries it here), different providers.
		const ra = await h.desired.resolved(a!);
		const rb = await h.desired.resolved(b!);
		expect(ra.plan.objective).toBe(rb.plan.objective);
		expect(ra.matches.map((m) => m.providerId)).toEqual(["alpha", "alpha"]);
		expect(rb.matches.map((m) => m.providerId)).toEqual(["beta", "beta"]);
		// prod-1 matches staging-1 exactly (no infra diff); prod-2 differs in provider.
		const deltas = [...h.desired.deltas.values()].map((d) => d.delta);
		const d1 = deltas.find((d) => d.campId === "prod-1");
		const d2 = deltas.find((d) => d.campId === "prod-2");
		expect(d1?.infrastructureDiff).toEqual([]);
		expect(d2?.infrastructureDiff.map((c) => [c.resource, c.kind, c.provider])).toEqual([
			["db", ChangeKind.UPDATE, "beta"],
			["web", ChangeKind.UPDATE, "beta"],
		]);
	});

	it("the diff is exact: changes against the base Set name each resource, kind and hash", async () => {
		const h = harness();
		h.freight.add("f1");
		h.freight.add("f2");
		const base = h.desired.seed("dev-1", "f1", resolvedFor("dev-1", "alpha", "f1"));
		const baseResolved = await h.desired.resolved(base);
		const result = await h.service.promote({ freightId: fid("f2"), targets: [camp("dev-1")], idempotencyKey: "k" }, h.ctx());
		expect(result.ok).toBe(true);
		const delta = [...h.desired.deltas.values()][0]?.delta;
		const after = resolvedFor("dev-1", "alpha", "f2");
		expect(delta?.baseSetId).toBe(base.setId);
		// Only `web` carries the Freight's image; `db` is unchanged and absent from the diff.
		expect(delta?.changes.map((c) => ({ resource: c.resource, kind: c.kind, provider: c.provider, before: c.beforeHash !== "", after: c.afterHash !== "" }))).toEqual([
			{ resource: "web", kind: ChangeKind.UPDATE, provider: "alpha", before: true, after: true },
		]);
		expect(delta?.changes[0]?.beforeHash).not.toBe(delta?.changes[0]?.afterHash);
		expect(baseResolved.contentHash).not.toBe(after.contentHash);
	});

	it("a duplicate idempotency key creates one promotion (§10: same promotion requested twice)", async () => {
		const h = harness();
		h.freight.add("f1");
		const first = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "same" }, h.ctx());
		const second = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "same" }, h.ctx());
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.value.promotionId).toBe(first.value.promotionId);
		expect(h.store.events(CD_EVENTS.EnvPromoteRequested)).toHaveLength(1);
		expect(h.desired.applied).toHaveLength(1);
		const reused = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-2")], idempotencyKey: "same" }, h.ctx());
		expect(reused.ok).toBe(false);
		if (!reused.ok) expect(reused.reasons[0]?.code).toBe(PROMOTION_REASON.idempotencyReused);
	});

	it("unqualified Freight is refused at prod (§10: lineage)", async () => {
		const h = harness();
		withPipeline(h);
		h.freight.add("f1");
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("prod-1")], idempotencyKey: "k", pipeline: "shop", node: "prod" }, h.ctx());
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reasons[0]?.code).toBe(LINEAGE_UNSATISFIED);
			expect(result.reasons[0]?.remediation).toMatch(/hotfix approval/);
		}
		expect(h.store.events(CD_EVENTS.EnvPromoteRequested)).toHaveLength(0);
		// Promoting without naming the pipeline does not bypass lineage.
		const bypass = await h.service.promote({ freightId: fid("f1"), targets: [camp("prod-1")], idempotencyKey: "k2" }, h.ctx());
		expect(bypass.ok).toBe(false);
		if (!bypass.ok) expect(bypass.reasons[0]?.code).toBe(LINEAGE_UNSATISFIED);
		// An unexpired hotfix approval for the target covers it.
		h.freight.approveFor("f1", "prod-1", h.clock.now() + HOUR);
		const hotfix = await h.service.promote({ freightId: fid("f1"), targets: [camp("prod-1")], idempotencyKey: "k3", pipeline: "shop", node: "prod" }, h.ctx());
		expect(hotfix.ok).toBe(true);
	});

	it("refuses targets outside the named node", async () => {
		const h = harness();
		withPipeline(h);
		h.freight.add("f1");
		h.pipelines.makeAvailable("shop", "staging", "f1");
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("prod-1")], idempotencyKey: "k", pipeline: "shop", node: "staging" }, h.ctx());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons[0]?.code).toBe(PROMOTION_REASON.targetOutsideNode);
	});

	it("supersession keeps only the newest (§10: two Freights queued for one Camp)", async () => {
		const h = harness();
		h.freight.add("f1");
		h.freight.add("f2");
		h.freight.add("f3");
		h.gate.effect = "require-approval";
		const p1 = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "a" }, h.ctx());
		const p2 = await h.service.promote({ freightId: fid("f2"), targets: [camp("dev-1")], idempotencyKey: "b" }, h.ctx());
		const p3 = await h.service.promote({ freightId: fid("f3"), targets: [camp("dev-1")], idempotencyKey: "c" }, h.ctx());
		expect(p1.ok && p2.ok && p3.ok).toBe(true);
		if (!p1.ok || !p2.ok || !p3.ok) return;
		await h.service.tick(h.ctx());
		expect((await h.service.get(p1.value.promotionId as never))?.state).toBe(PromotionState.SUPERSEDED);
		expect((await h.service.get(p2.value.promotionId as never))?.state).toBe(PromotionState.SUPERSEDED);
		expect((await h.service.get(p3.value.promotionId as never))?.state).toBe(PromotionState.AWAITING_APPROVAL);
		expect(h.store.events(CD_EVENTS.EnvPromoteSuperseded)).toHaveLength(2);
		const approved = await h.service.approve(p3.value.promotionId as never, h.ctx(APPROVER));
		expect(approved.ok && approved.value.state).toBe(PromotionState.PROMOTED);
		expect((await h.desired.current(camp("dev-1")))?.freightId).toBe("f3");
		expect(h.telemetry.named(PROMOTION_METRIC.superseded)).toHaveLength(2);
	});

	it("a promotion that holds a Camp (applied) is never superseded; the newer one waits", async () => {
		const h = harness();
		h.freight.add("f1");
		h.freight.add("f2");
		h.verification.pending = true;
		const p1 = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "a" }, h.ctx());
		const p2 = await h.service.promote({ freightId: fid("f2"), targets: [camp("dev-1")], idempotencyKey: "b" }, h.ctx());
		if (!p1.ok || !p2.ok) throw new Error("expected both requests");
		expect((await h.service.get(p1.value.promotionId as never))?.state).toBe(PromotionState.VERIFYING);
		expect((await h.service.get(p2.value.promotionId as never))?.state).toBe(PromotionState.QUEUED);
		h.verification.pending = false;
		await h.service.tick(h.ctx());
		await h.service.tick(h.ctx());
		expect((await h.service.get(p1.value.promotionId as never))?.state).toBe(PromotionState.PROMOTED);
		expect((await h.service.get(p2.value.promotionId as never))?.state).toBe(PromotionState.PROMOTED);
		expect((await h.desired.current(camp("dev-1")))?.freightId).toBe("f2");
	});

	it("a group failure compensates: applied members roll back to their predecessors", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
		h.desired.seed("dev-2", "f0", resolvedFor("dev-2", "alpha", "f0"));
		h.verification.verdictByCamp.set("dev-2", VerificationVerdict.FAIL);
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1"), camp("dev-2")], idempotencyKey: "g" }, h.ctx());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const record = await h.service.get(result.value.promotionId as never);
		expect(record?.state).toBe(PromotionState.FAILED);
		expect((await h.desired.current(camp("dev-1")))?.freightId).toBe("f0");
		expect((await h.desired.current(camp("dev-2")))?.freightId).toBe("f0");
		expect((await h.desired.current(camp("dev-1")))?.origin).toBe(SetOrigin.ROLLBACK);
		expect(h.rollouts.rollbacks).toHaveLength(2);
		expect(record?.reasons.map((r) => r.code)).toEqual(
			expect.arrayContaining([PROMOTION_REASON.verificationFailed, PROMOTION_REASON.compensated]),
		);
		expect(h.store.events("saga.Compensated")).toHaveLength(1);
		// The rollback Deltas went through the same gate (I7).
		expect(h.gate.calls.filter((c) => c.intent === "rollback")).toHaveLength(2);
	});

	it("verification FAIL never qualifies and restores the predecessor (I5, D12)", async () => {
		const h = harness();
		withPipeline(h);
		h.freight.add("f0");
		h.freight.add("f1");
		h.desired.seed("staging-1", "f0", resolvedFor("staging-1", "alpha", "f0"));
		h.pipelines.makeAvailable("shop", "staging", "f1");
		h.verification.verdict = VerificationVerdict.INCONCLUSIVE;
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("staging-1")], idempotencyKey: "v", pipeline: "shop", node: "staging" }, h.ctx());
		expect(result.ok && result.value.state).toBe(PromotionState.FAILED);
		expect(h.freight.qualifiedList).toHaveLength(0);
		expect((await h.desired.current(camp("staging-1")))?.freightId).toBe("f0");
	});

	it("an agent principal gets a proposal only; a human approval applies it", async () => {
		const h = harness();
		h.freight.add("f1");
		const proposed = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "p" }, h.ctx(AGENT));
		expect(proposed.ok).toBe(true);
		if (!proposed.ok) return;
		expect(proposed.value.proposal).toBe(true);
		expect(proposed.value.state).toBe(PromotionState.AWAITING_APPROVAL);
		expect(h.desired.applied).toHaveLength(0);
		expect([...h.desired.deltas.values()][0]?.delta.proposal).toBe(true);
		// The agent cannot approve its own proposal.
		const self = await h.service.approve(proposed.value.promotionId as never, h.ctx(AGENT));
		expect(self.ok).toBe(false);
		const approved = await h.service.approve(proposed.value.promotionId as never, h.ctx(APPROVER));
		expect(approved.ok && approved.value.state).toBe(PromotionState.PROMOTED);
		expect(h.desired.applied).toHaveLength(1);
	});

	it("a promotion requested during a freeze waits in AWAITING_WINDOW and proceeds when it opens (§10)", async () => {
		const h = harness();
		h.freight.add("f1");
		h.gate.window = { open: false, rollbackAllowed: true, activeFreezes: ["holiday"], overrides: [], nextOpenAtMs: h.clock.now() + HOUR };
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "w" }, h.ctx());
		expect(result.ok && result.value.state).toBe(PromotionState.AWAITING_WINDOW);
		expect(h.desired.applied).toHaveLength(0);
		h.gate.window = { open: true, rollbackAllowed: true, activeFreezes: [], overrides: [] };
		h.clock.advance(HOUR);
		await h.service.tick(h.ctx());
		if (result.ok) expect((await h.service.get(result.value.promotionId as never))?.state).toBe(PromotionState.PROMOTED);
		expect(WINDOW_CLOSED).toBe("window-closed");
	});

	it("I13: yanked Freight never starts and never continues", async () => {
		const h = harness();
		h.freight.add("f1");
		h.freight.unusable.add("f1");
		const start = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "y" }, h.ctx());
		expect(start.ok).toBe(false);
		if (!start.ok) expect(start.reasons[0]?.code).toBe(PROMOTION_REASON.freightUnusable);
		h.freight.unusable.delete("f1");
		h.verification.pending = true;
		const running = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "y2" }, h.ctx());
		h.freight.unusable.add("f1");
		await h.service.tick(h.ctx());
		if (running.ok) expect((await h.service.get(running.value.promotionId as never))?.state).toBe(PromotionState.FAILED);
	});

	it("hooks: BEFORE_APPLY runbook failure rejects before apply and ON_FAILURE runs", async () => {
		const h = harness();
		h.pipelines.define("shop", [
			pipelineNode("dev", {
				campIds: ["dev-1"],
				hooks: [
					{ kind: HookKind.RUNBOOK, point: HookPoint.BEFORE_APPLY, ref: "runbooks/precheck.json" },
					{ kind: HookKind.NOTIFY, point: HookPoint.ON_FAILURE, ref: "ops" },
					{ kind: HookKind.SUITE, point: HookPoint.AFTER_CONVERGED, ref: "smoke" },
				],
			}),
		]);
		h.freight.add("f1");
		h.pipelines.makeAvailable("shop", "dev", "f1");
		h.runbooks.failing.add("runbooks/precheck.json");
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "h", pipeline: "shop", node: "dev" }, h.ctx());
		expect(result.ok && result.value.state).toBe(PromotionState.REJECTED);
		expect(h.desired.applied).toHaveLength(0);
		expect(h.notify.sent.map((s) => s.channel)).toEqual(["ops"]);
		h.runbooks.failing.clear();
		const again = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "h2", pipeline: "shop", node: "dev" }, h.ctx());
		expect(again.ok && again.value.state).toBe(PromotionState.PROMOTED);
		expect(h.suites.runs).toEqual(["smoke"]);
		expect(h.freight.qualifiedList.map((q) => [q.campId, q.node])).toEqual([["dev-1", "dev"]]);
	});

	it("resumes from its journal after a restart (crash between ticks)", async () => {
		const h = harness();
		h.freight.add("f1");
		h.verification.pending = true;
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "r" }, h.ctx());
		if (!result.ok) throw new Error("expected request");
		const restarted = h.restart();
		h.verification.pending = false;
		await restarted.tick(h.ctx());
		expect((await restarted.get(result.value.promotionId as never))?.state).toBe(PromotionState.PROMOTED);
		expect(h.desired.applied).toHaveLength(1);
		expect(h.rollouts.plans).toHaveLength(1);
		expect(h.verification.started).toHaveLength(1);
		const steps = h.store.stream(CD_STREAMS.promotion(result.value.promotionId)).filter((e) => e.type === "saga.StepEmitted");
		expect(new Set(steps.map((e) => JSON.stringify(e.data))).size).toBe(steps.length);
		expect(steps.some((e) => JSON.stringify(e.data).includes(STEP.qualified))).toBe(true);
	});

	it("a gate denial rejects the Delta and records the gate's reasons", async () => {
		const h = harness();
		h.freight.add("f1");
		h.gate.denyCamps.add("dev-1");
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "d" }, h.ctx());
		expect(result.ok && result.value.state).toBe(PromotionState.REJECTED);
		if (result.ok) expect(result.value.reasons.map((r) => r.code)).toEqual([PROMOTION_REASON.gateDenied, "policy-denied"]);
		expect([...h.desired.deltas.values()][0]?.status).toBe("rejected");
	});

	it("an approval expires after the TTL and the promotion is refused", async () => {
		const h = harness();
		h.freight.add("f1");
		h.gate.effect = "require-approval";
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "e" }, h.ctx());
		expect(result.ok && result.value.state).toBe(PromotionState.AWAITING_APPROVAL);
		expect(h.notify.sent.map((s) => s.channel)).toEqual(["a2h"]);
		h.clock.advance(25 * HOUR);
		await h.service.tick(h.ctx());
		if (result.ok) {
			const record = await h.service.get(result.value.promotionId as never);
			expect(record?.state).toBe(PromotionState.REJECTED);
			expect(record?.reasons[0]?.code).toBe(PROMOTION_REASON.approvalExpired);
		}
	});

	it("lists promotions newest first and filters by Camp", async () => {
		const h = harness();
		h.freight.add("f1");
		await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "1" }, h.ctx());
		h.clock.advance(MINUTE);
		await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-2")], idempotencyKey: "2" }, h.ctx());
		const all = await h.service.list();
		expect(all.map((p) => p.targetCampIds[0])).toEqual(["dev-2", "dev-1"]);
		expect((await h.service.list({ campId: camp("dev-1") })).map((p) => p.idempotencyKey)).toEqual(["1"]);
		expect(await h.service.list({ limit: 1 })).toHaveLength(1);
	});
});

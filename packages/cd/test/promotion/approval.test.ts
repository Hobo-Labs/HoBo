// A2H and webhook approvers (approval.ts): governed decisions, expiry,
// signed callbacks, replay.
import type { JsonObject, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { PromotionState } from "../../src/_generated/cd_pb.js";
import {
	APPROVAL_REASON,
	approvalSubject,
	createA2HApprover,
	createWebhookApprover,
	parseApprovalSubject,
} from "../../src/adapters/approval.js";
import { FakeNotify, RecordingAuthorizer, RecordingTelemetry } from "./doubles.js";
import { harness } from "./harness.js";
import { AGENT, APPROVER, camp, clock, context, fid, HOUR, MemoryEventStore, T0, TENANT } from "./store.js";

describe("approval subjects", () => {
	it("round-trips promotion subjects and rejects malformed ones", () => {
		expect(parseApprovalSubject(approvalSubject("promo_1", "prod-1"))).toEqual({ promotionId: "promo_1", scope: "prod-1" });
		expect(parseApprovalSubject("promotion:promo_1/prod-1/stage-2")).toEqual({ promotionId: "promo_1", scope: "prod-1/stage-2" });
		for (const bad of ["prod-1", "promotion:/prod-1", "promotion:promo_1/", "promotion:promo 1/prod-1", "promotion:p|x/c"])
			expect(parseApprovalSubject(bad)).toBeUndefined();
	});
});

describe("A2H approver", () => {
	function a2h() {
		const c = clock(T0);
		const store = new MemoryEventStore(c.now);
		const notify = new FakeNotify();
		const approver = createA2HApprover({ store, tenant: TENANT, now: c.now, notify, authorizer: new RecordingAuthorizer(), telemetry: new RecordingTelemetry() });
		return { c, approver, notify };
	}

	it("hands off to a human, who decides; agents cannot decide (ADR-0094)", async () => {
		const { c, approver, notify } = a2h();
		const { requestId } = await approver.request({ subject: "promotion:promo_1/prod-1", summary: "Promote f1", obligations: ["change-ticket"], expiresAtMs: T0 + HOUR }, context(c.now));
		expect(notify.sent[0]?.channel).toBe("a2h");
		expect(notify.sent[0]?.body).toMatchObject({ requestId, obligations: ["change-ticket"] });
		expect(await approver.status(requestId)).toBe("pending");
		const agent = await approver.decide({ requestId, approve: true }, context(c.now, AGENT));
		expect(agent.ok).toBe(false);
		if (!agent.ok) expect(agent.reasons[0]?.code).toBe(APPROVAL_REASON.unauthorized);
		expect((await approver.decide({ requestId, approve: false }, context(c.now, APPROVER))).ok).toBe(true);
		expect(await approver.status(requestId)).toBe("denied");
		const flip = await approver.decide({ requestId, approve: true }, context(c.now, APPROVER));
		expect(flip.ok).toBe(false);
		if (!flip.ok) expect(flip.reasons[0]?.code).toBe(APPROVAL_REASON.alreadyDecided);
	});

	it("expires at its deadline and refuses late decisions", async () => {
		const { c, approver } = a2h();
		const { requestId } = await approver.request({ subject: "promotion:promo_1/prod-1", summary: "s", obligations: [], expiresAtMs: T0 + HOUR }, context(c.now));
		c.advance(HOUR);
		expect(await approver.status(requestId)).toBe("expired");
		const late = await approver.decide({ requestId, approve: true }, context(c.now, APPROVER));
		expect(late.ok).toBe(false);
		if (!late.ok) expect(late.reasons[0]?.code).toBe(APPROVAL_REASON.expired);
	});

	it("refuses malformed subjects and unknown requests", async () => {
		const { c, approver } = a2h();
		await expect(approver.request({ subject: "prod-1", summary: "s", obligations: [], expiresAtMs: T0 + HOUR }, context(c.now))).rejects.toThrow(APPROVAL_REASON.subjectInvalid);
		const unknown = await approver.decide({ requestId: "promotion:promo_9/prod-1", approve: true }, context(c.now, APPROVER));
		expect(unknown.ok).toBe(false);
		expect(await approver.status("nonsense")).toBe("denied");
	});

	it("decides a waiting promotion through the shared journal", async () => {
		const h = harness();
		h.freight.add("f1");
		h.gate.effect = "require-approval";
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "a" }, h.ctx());
		if (!result.ok) throw new Error("expected request");
		const decided = await h.approvals.decide({ requestId: approvalSubject(result.value.promotionId, "dev-1"), approve: true }, h.ctx(APPROVER));
		expect(decided.ok).toBe(true);
		await h.service.tick(h.ctx());
		expect((await h.service.get(result.value.promotionId as never))?.state).toBe(PromotionState.PROMOTED);
	});

	it("rollout-stage approvals on the same stream are not Camp progress", async () => {
		const h = harness();
		h.freight.add("f1");
		h.verification.pending = true;
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "a" }, h.ctx());
		if (!result.ok) throw new Error("expected request");
		await h.approvals.request({ subject: `promotion:${result.value.promotionId}/dev-1/stage-2`, summary: "stage 2", obligations: [], expiresAtMs: T0 + HOUR }, h.ctx());
		const record = await h.service.get(result.value.promotionId as never);
		expect(record?.targetCampIds).toEqual(["dev-1"]);
		expect(record?.state).toBe(PromotionState.VERIFYING);
	});
});

describe("webhook approver", () => {
	function webhook(status = 202) {
		const c = clock(T0);
		const store = new MemoryEventStore(c.now);
		const sent: TransportRequest[] = [];
		const approver = createWebhookApprover({
			store,
			tenant: TENANT,
			now: c.now,
			http: async (request) => {
				sent.push(request);
				return { status, headers: {}, body: "" };
			},
			endpoint: "https://approvals.example/hooks",
			callbackUrl: "https://cd.example/v1/cd/approvals/callback",
			source: "hobo://cd/acme",
			secrets: { resolver: { resolve: async () => ({ secret: "k" }) }, ref: "vault://k" },
			authorizer: new RecordingAuthorizer(),
			telemetry: new RecordingTelemetry(),
		});
		const call = async (body: JsonObject, method = "POST") => {
			const response = await approver.callback({ method, path: "/cb", headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) }, context(c.now));
			return response.status;
		};
		return { c, approver, sent, call };
	}

	it("never carries the secret in the request, and the token verifies only with it", async () => {
		const w = webhook();
		await w.approver.request({ subject: "promotion:promo_1/prod-1", summary: "s", obligations: [], expiresAtMs: T0 + HOUR }, context(w.c.now));
		expect(w.sent[0]?.body).not.toContain('"k"');
		const token = JSON.parse(w.sent[0]?.body ?? "{}").data.callback.token;
		expect(await w.call({ token, decision: "approved", approver: "bot" })).toBe(200);
		expect(await w.call({ token, decision: "approved", approver: "bot" })).toBe(200);
		expect(await w.call({ token, decision: "denied", approver: "bot" })).toBe(409);
		expect(await w.approver.status("promotion:promo_1/prod-1")).toBe("approved");
	});

	it("refuses expired tokens, malformed bodies and other methods", async () => {
		const w = webhook();
		await w.approver.request({ subject: "promotion:promo_1/prod-1", summary: "s", obligations: [], expiresAtMs: T0 + HOUR }, context(w.c.now));
		const token = JSON.parse(w.sent[0]?.body ?? "{}").data.callback.token;
		expect(await w.call({ token, decision: "maybe", approver: "bot" })).toBe(400);
		expect(await w.call({ token: "no-dot", decision: "approved", approver: "bot" })).toBe(401);
		expect(await w.call({ token, decision: "approved", approver: "bot" }, "GET")).toBe(405);
		w.c.advance(HOUR);
		expect(await w.call({ token, decision: "approved", approver: "bot" })).toBe(410);
	});

	it("surfaces an endpoint failure to the saga (which retries on its next tick)", async () => {
		const w = webhook(500);
		await expect(w.approver.request({ subject: "promotion:promo_1/prod-1", summary: "s", obligations: [], expiresAtMs: T0 + HOUR }, context(w.c.now))).rejects.toThrow(/500/);
	});
});

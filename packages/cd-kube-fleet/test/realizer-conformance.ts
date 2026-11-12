// The `Realizer` conformance properties (frozen port contract in
// @hobo/cd ports.ts: "Drive toward `desired`. Idempotent. Never reports
// convergence without observation."), run against each hub realizer. WP20
// owns the shared conformance suite in @hobo/conformance; this kit holds the
// same properties locally so the package is green in isolation, and the
// realizers are added to WP20's suite at merge.
import { type Realizer, ReconcileStatus } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import type { FakeHub } from "./fake-hub.js";
import {
	ctx,
	deployment,
	HUB_TOKEN,
	realizeInput,
	recordingSink,
} from "./fixtures.js";

export type RealizerHarness = Readonly<{
	hub: FakeHub;
	/** Build the realizer for Camp `camp-a` (mapped) with the given telemetry sink. */
	realizer(sink?: ReturnType<typeof recordingSink>): Realizer;
	/** Run the hub's controllers once (OCM work agent / Karmada binding controller). */
	settle(): void;
}>;

const CAMP = "camp-a";
const web = [deployment("web", "registry.example/web@sha256:aaaa", 2)];

export function describeRealizerConformance(
	name: string,
	make: () => RealizerHarness,
): void {
	describe(`Realizer conformance: ${name}`, () => {
		it("never reports CONVERGED before the hub observes the apply", async () => {
			const h = make();
			const r = h.realizer();
			const first = await r.converge(realizeInput(CAMP, web), ctx);
			expect(first.status).toBe(ReconcileStatus.CONVERGING);
			expect(first.reasons.length).toBeGreaterThan(0);
			h.settle();
			const second = await r.converge(realizeInput(CAMP, web), ctx);
			expect(second.status).toBe(ReconcileStatus.CONVERGED);
		});

		it("is idempotent: re-converging a converged Camp makes no mutating call", async () => {
			const h = make();
			const r = h.realizer();
			await r.converge(realizeInput(CAMP, web), ctx);
			h.settle();
			await r.converge(realizeInput(CAMP, web), ctx);
			const before = h.hub.mutatingCalls().length;
			const again = await r.converge(realizeInput(CAMP, web), ctx);
			expect(again.status).toBe(ReconcileStatus.CONVERGED);
			expect(h.hub.mutatingCalls().length).toBe(before);
		});

		it("observe never mutates, whatever the hub state", async () => {
			const h = make();
			const r = h.realizer();
			await r.observe(realizeInput(CAMP, web), ctx);
			expect(h.hub.mutatingCalls()).toHaveLength(0);
			await r.converge(realizeInput(CAMP, web), ctx);
			const before = h.hub.mutatingCalls().length;
			await r.observe(realizeInput(CAMP, web), ctx);
			h.settle();
			const observed = await r.observe(realizeInput(CAMP, web), ctx);
			expect(observed.status).toBe(ReconcileStatus.CONVERGED);
			expect(h.hub.mutatingCalls().length).toBe(before);
		});

		it("observe reports a Camp that was never applied as drift, not convergence", async () => {
			const h = make();
			const observed = await h.realizer().observe(realizeInput(CAMP, web), ctx);
			expect(observed.status).toBe(ReconcileStatus.DRIFTED);
			expect(observed.resources.every((r) => r.driftKind === "deleted")).toBe(
				true,
			);
		});

		it("stamps the observation with Camp, Set, reconciler, fence and the injected clock", async () => {
			const h = make();
			const input = realizeInput(CAMP, web, {
				fence: 42n,
				reconcilerId: "rec-9",
			});
			const record = await h.realizer().converge(input, ctx);
			expect(record.campId).toBe(CAMP);
			expect(record.setId).toBe(input.desired.setId);
			expect(record.reconcilerId).toBe("rec-9");
			expect(record.fenceToken).toBe("42");
			expect(record.observedAt).toBe("2026-11-12T10:00:00.000Z");
			expect(record.resources.map((r) => r.resource)).toEqual(["web"]);
			expect(record.resources[0]?.kind).toBe("compute");
		});

		it("refuses a stale fence without mutating", async () => {
			const h = make();
			const r = h.realizer();
			await r.converge(realizeInput(CAMP, web, { fence: 9n }), ctx);
			h.settle();
			const before = h.hub.mutatingCalls().length;
			const stale = await r.converge(
				realizeInput(
					CAMP,
					[deployment("web", "registry.example/web@sha256:bbbb")],
					{ fence: 7n },
				),
				ctx,
			);
			expect(stale.status).toBe(ReconcileStatus.BLOCKED);
			expect(stale.reasons.map((x) => x.code)).toContain("stale-fence");
			expect(h.hub.mutatingCalls().length).toBe(before);
		});

		it("rejects an aborted pass before any hub call", async () => {
			const h = make();
			const controller = new AbortController();
			controller.abort(new Error("lease lost"));
			await expect(
				h
					.realizer()
					.converge(
						realizeInput(CAMP, web, { signal: controller.signal }),
						ctx,
					),
			).rejects.toThrow("lease lost");
			expect(h.hub.log).toHaveLength(0);
		});

		it("blocks a resolved set that does not match the Set's content hash, with no hub call", async () => {
			const h = make();
			const input = realizeInput(CAMP, web);
			const tampered = {
				...input,
				resolved: { ...input.resolved, contentHash: "sha256:0000" as const },
			};
			const record = await h.realizer().converge(tampered, ctx);
			expect(record.status).toBe(ReconcileStatus.BLOCKED);
			expect(record.reasons[0]?.code).toBe("resolved-set-mismatch");
			expect(h.hub.log).toHaveLength(0);
		});

		it("blocks an unmapped Camp with a typed reason and no hub call", async () => {
			const h = make();
			const record = await h
				.realizer()
				.converge(realizeInput("camp-unknown", web), ctx);
			expect(record.status).toBe(ReconcileStatus.BLOCKED);
			expect(record.reasons[0]?.code).toBe("kube-cluster-unmapped");
			expect(record.reasons[0]?.remediation).not.toBe("");
			expect(h.hub.log).toHaveLength(0);
		});

		it("refuses a Secret manifest (I9) before any hub call", async () => {
			const h = make();
			const secret = {
				name: "creds",
				productId: "secret",
				params: { spec: { type: "Opaque" } },
			};
			const record = await h
				.realizer()
				.converge(realizeInput(CAMP, [...web, secret]), ctx);
			expect(record.status).toBe(ReconcileStatus.BLOCKED);
			expect(record.reasons[0]?.code).toBe("kube-secret-refused");
			expect(h.hub.log).toHaveLength(0);
		});

		it("fails closed on a hub outage: BLOCKED with kube-unavailable, never converged", async () => {
			const h = make();
			h.hub.failWith = 503;
			const record = await h.realizer().converge(realizeInput(CAMP, web), ctx);
			expect(record.status).toBe(ReconcileStatus.BLOCKED);
			expect(record.reasons[0]?.code).toBe("kube-unavailable");
		});

		it("maps a refused token to kube-auth-failed", async () => {
			const h = make();
			h.hub.token = "rotated";
			const record = await h.realizer().converge(realizeInput(CAMP, web), ctx);
			expect(record.status).toBe(ReconcileStatus.BLOCKED);
			expect(record.reasons[0]?.code).toBe("kube-auth-failed");
		});

		it("keeps the credential out of every record and metric (I9)", async () => {
			const h = make();
			const sink = recordingSink();
			const r = h.realizer(sink);
			await r.converge(realizeInput(CAMP, web), ctx);
			h.settle();
			const record = await r.converge(realizeInput(CAMP, web), ctx);
			expect(
				JSON.stringify(record, (_k, v) =>
					typeof v === "bigint" ? String(v) : v,
				),
			).not.toContain(HUB_TOKEN);
			expect(JSON.stringify(sink.points)).not.toContain(HUB_TOKEN);
			expect(
				sink.points.some((p) => p.name === "hobo.cd.kube_fleet.realize.passes"),
			).toBe(true);
			expect(
				h.hub.log.every((l) => l.authorization === `Bearer ${HUB_TOKEN}`),
			).toBe(true);
			// The bearer token travels in the Authorization header only, never in a body.
			expect(
				JSON.stringify(h.hub.log.map((l) => l.body ?? null)),
			).not.toContain(HUB_TOKEN);
		});
	});
}

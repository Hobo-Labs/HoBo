// ShadowRecorder (plan 0024 D24): the gate's view of the candidate Rail while
// a Camp is bound in INFORM, and the record of each shadow decision.
import { create } from "@bufbuild/protobuf";
import { createPermissiveDefaultPack, type PolicyPack } from "@hobo/contracts";
import { describe, expect, it } from "vitest";
import {
	PolicyMode,
	ShadowDecisionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type { Digest } from "../../src/ports.js";
import {
	createCampPolicy,
	createShadowRecorder,
	PostureJournalError,
} from "../../src/posture/index.js";
import {
	camp,
	clock,
	context,
	digest,
	MemoryEventStore,
	promotion,
	RecordingAuthorizer,
	RecordingTelemetry,
	railFreight,
	TENANT,
} from "./fakes.js";

const PROD = camp("prod-1");
const RAIL_B = digest("b");

function harness() {
	const store = new MemoryEventStore();
	const time = clock();
	const authorizer = new RecordingAuthorizer();
	const telemetry = new RecordingTelemetry();
	const campPolicy = createCampPolicy({
		store,
		tenant: TENANT,
		now: time.now,
		authorizer,
	});
	const resolved: Digest[] = [];
	const pack: PolicyPack = {
		...createPermissiveDefaultPack(),
		id: "candidate",
	};
	const shadow = createShadowRecorder({
		store,
		tenant: TENANT,
		now: time.now,
		campPolicy,
		telemetry,
		resolvePack: async (railDigest) => {
			resolved.push(railDigest);
			return pack;
		},
	});
	return {
		store,
		time,
		campPolicy,
		shadow,
		telemetry,
		resolved,
		pack,
		ctx: context(time.now),
	};
}

function decision(
	over: Partial<{
		deltaId: string;
		enforced: string;
		candidate: string;
		diverged: boolean;
		campId: string;
		candidateRail: string;
	}> = {},
) {
	return create(ShadowDecisionRecordSchema, {
		campId: over.campId ?? PROD,
		deltaId: over.deltaId ?? "delta-1",
		enforcedRailDigest: digest("a"),
		candidateRailDigest: over.candidateRail ?? RAIL_B,
		enforcedEffect: over.enforced ?? "allow",
		candidateEffect: over.candidate ?? "deny",
		diverged: over.diverged ?? true,
		decidedAt: "2026-11-12T12:00:00.000Z",
	});
}

describe("ShadowRecorder", () => {
	it("has no candidate until a Rail is bound in INFORM, then returns its digest and resolved pack", async () => {
		const h = harness();
		expect(await h.shadow.candidate(PROD)).toBeUndefined();
		await h.campPolicy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_B),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		const candidate = await h.shadow.candidate(PROD);
		expect(candidate?.railDigest).toBe(RAIL_B);
		expect(candidate?.policyPack).toBe(h.pack);
		expect(h.resolved).toEqual([RAIL_B]);
	});

	it("records policy.ShadowDecided on the Camp's compliance stream, once per Delta and candidate", async () => {
		const h = harness();
		await h.shadow.record(decision(), h.ctx);
		await h.shadow.record(decision(), h.ctx);
		const events = h.store.events(CD_STREAMS.compliance(PROD));
		expect(events.map((e) => e.type)).toEqual([CD_EVENTS.PolicyShadowDecided]);
		expect(
			h.telemetry.named("hobo.cd.policy.shadow_divergence").map((p) => p.value),
		).toEqual([1]);
	});

	it("derives divergence from the two effects, never from the caller's flag", async () => {
		const h = harness();
		await h.shadow.record(
			decision({
				deltaId: "d2",
				enforced: "allow",
				candidate: "allow",
				diverged: true,
			}),
			h.ctx,
		);
		const recorded = h.store.events(CD_STREAMS.compliance(PROD))[0]?.data;
		expect(recorded).not.toHaveProperty("diverged");
		await h.shadow.record(
			decision({
				deltaId: "d3",
				enforced: "allow",
				candidate: "deny",
				diverged: false,
			}),
			h.ctx,
		);
		expect(h.store.events(CD_STREAMS.compliance(PROD))[1]?.data).toHaveProperty(
			"diverged",
			true,
		);
	});

	it("refuses a malformed decision with a typed error (fail closed, nothing recorded)", async () => {
		const h = harness();
		await expect(
			h.shadow.record(decision({ candidateRail: "nope" }), h.ctx),
		).rejects.toBeInstanceOf(PostureJournalError);
		await expect(
			h.shadow.record(decision({ campId: "" }), h.ctx),
		).rejects.toThrow(/policy-shadow-invalid/u);
		expect(h.store.all).toHaveLength(0);
	});
});

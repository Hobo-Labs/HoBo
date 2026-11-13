// CampPolicy (plan 0024 D24, I23): Rail bindings folded from the Camp spec
// stream, written by promotion only. INFORM sets the candidate; ENFORCE swaps
// the enforced Rail and clears the candidate; restore rolls back.
import { create, toJson } from "@bufbuild/protobuf";
import type { JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	FreightApprovedRecordSchema,
	FreightQualifiedRecordSchema,
	FreightRecordSchema,
	FreightSubject,
	PipelineRecordSchema,
	PolicyBindingRecordSchema,
	PolicyMode,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS, SHADOW_REQUIRED } from "../../src/events.js";
import {
	createCampPolicy,
	governingRailDigest,
} from "../../src/posture/index.js";
import {
	AGENT,
	camp,
	clock,
	context,
	digest,
	freightId,
	HOUR,
	MemoryEventStore,
	promotion,
	RecordingAuthorizer,
	RecordingTelemetry,
	railFreight,
	T0,
	TENANT,
} from "./fakes.js";

const PROD = camp("prod-1");
const RAIL_A = digest("a");
const RAIL_B = digest("b");

function harness() {
	const store = new MemoryEventStore();
	const time = clock();
	const authorizer = new RecordingAuthorizer();
	const telemetry = new RecordingTelemetry();
	const policy = createCampPolicy({
		store,
		tenant: TENANT,
		now: time.now,
		authorizer,
		telemetry,
	});
	return { store, time, authorizer, telemetry, policy, ctx: context(time.now) };
}

type Harness = ReturnType<typeof harness>;

/** Record that the Rail Freight qualified on an INFORM node (the I23 precondition). */
async function qualifyOnInform(
	h: Harness,
	freight: ReturnType<typeof railFreight>,
	mode = PolicyMode.INFORM,
) {
	const pipeline = create(PipelineRecordSchema, {
		schemaVersion: "hobo.cd.pipeline/v1",
		name: "rail-eu",
		bindle: "rail-eu",
		subject: FreightSubject.RAIL,
		nodes: [
			{ name: "shadow", campIds: ["staging-1"], policyMode: mode },
			{
				name: "enforce",
				campIds: [PROD],
				fromNodes: ["shadow"],
				policyMode: PolicyMode.ENFORCE,
			},
		],
	});
	// SAFETY: toJson of a message is a JSON object.
	await h.store.put(
		CD_STREAMS.pipeline("rail-eu"),
		CD_EVENTS.PipelineApplied,
		toJson(PipelineRecordSchema, pipeline) as JsonObject,
	);
	const qualified = create(FreightQualifiedRecordSchema, {
		freightId: freight.freightId,
		campId: "staging-1",
		pipeline: "rail-eu",
		node: "shadow",
		verificationId: "ver-1",
		qualifiedAt: new Date(T0).toISOString(),
	});
	await h.store.put(
		CD_STREAMS.freight(freight.freightId),
		CD_EVENTS.FreightQualified,
		// SAFETY: toJson of a message is a JSON object.
		toJson(FreightQualifiedRecordSchema, qualified) as JsonObject,
	);
}

describe("CampPolicy: inform then enforce", () => {
	it("INFORM binds the candidate and leaves the enforced Rail deciding", async () => {
		const h = harness();
		const freight = railFreight(RAIL_A);
		const bound = await h.policy.bind(
			{
				campId: PROD,
				freight,
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		expect(bound.ok).toBe(true);
		const binding = await h.policy.binding(PROD);
		expect(binding?.candidateRailDigest).toBe(RAIL_A);
		// No enforced binding yet: the Station's active Rail still decides.
		expect(binding?.enforcedRailDigest).toBe("");
		expect(governingRailDigest(binding, RAIL_B)).toBe(RAIL_B);
		expect(h.authorizer.calls.map((c) => c.action)).toEqual(["rail.promote"]);
	});

	it("ENFORCE swaps the enforced Rail and clears the candidate once INFORM qualified upstream", async () => {
		const h = harness();
		const freight = railFreight(RAIL_A);
		await h.policy.bind(
			{
				campId: PROD,
				freight,
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		await qualifyOnInform(h, freight);
		const enforced = await h.policy.bind(
			{
				campId: PROD,
				freight,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p2"),
			},
			h.ctx,
		);
		expect(enforced.ok).toBe(true);
		const binding = await h.policy.binding(PROD);
		expect(binding?.enforcedRailDigest).toBe(RAIL_A);
		expect(binding?.candidateRailDigest).toBe("");
		expect(governingRailDigest(binding, RAIL_B)).toBe(RAIL_A);
		expect(h.telemetry.named("hobo.cd.policy.binding_changed")).toHaveLength(2);
	});

	it("refuses ENFORCE without a qualified INFORM node upstream or an approval (I23)", async () => {
		const h = harness();
		const freight = railFreight(RAIL_A);
		const refused = await h.policy.bind(
			{
				campId: PROD,
				freight,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.reasons[0]?.code).toBe(SHADOW_REQUIRED);
		expect(refused.reasons[0]?.remediation).toMatch(/INFORM/u);
		// Qualification on an ENFORCE node does not count as shadowing.
		await qualifyOnInform(h, freight, PolicyMode.ENFORCE);
		const still = await h.policy.bind(
			{
				campId: PROD,
				freight,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		expect(still.ok).toBe(false);
		expect(h.store.events(CD_STREAMS.campSpec(PROD))).toHaveLength(0);
	});

	it("accepts ENFORCE under an unexpired approval for the Camp, never an expired one", async () => {
		const h = harness();
		const freight = railFreight(RAIL_A);
		const approval = (expiresAtMs: number) =>
			create(FreightApprovedRecordSchema, {
				freightId: freight.freightId,
				campId: PROD,
				reason: "hotfix",
				approvedBy: "user:ciso@acme",
				approvedAt: new Date(T0).toISOString(),
				expiresAt: new Date(expiresAtMs).toISOString(),
			});
		await h.store.put(
			CD_STREAMS.freight(freight.freightId),
			CD_EVENTS.FreightApproved,
			// SAFETY: toJson of a message is a JSON object.
			toJson(FreightApprovedRecordSchema, approval(T0 - 1)) as JsonObject,
		);
		const expired = await h.policy.bind(
			{
				campId: PROD,
				freight,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		expect(expired.ok).toBe(false);
		await h.store.put(
			CD_STREAMS.freight(freight.freightId),
			CD_EVENTS.FreightApproved,
			// SAFETY: toJson of a message is a JSON object.
			toJson(FreightApprovedRecordSchema, approval(T0 + HOUR)) as JsonObject,
		);
		const approved = await h.policy.bind(
			{
				campId: PROD,
				freight,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		expect(approved.ok).toBe(true);
	});

	it("is idempotent per promotion and writes a PolicyBindingRecord body to the spec stream", async () => {
		const h = harness();
		const freight = railFreight(RAIL_A);
		const input = {
			campId: PROD,
			freight,
			mode: PolicyMode.INFORM,
			promotionId: promotion("p1"),
		};
		const first = await h.policy.bind(input, h.ctx);
		const second = await h.policy.bind(input, h.ctx);
		expect(second).toEqual(first);
		const events = h.store.events(CD_STREAMS.campSpec(PROD));
		expect(events.map((e) => e.type)).toEqual([CD_EVENTS.PolicyBindingChanged]);
		const body = events[0]?.data;
		// Exactly the protobuf JSON of the record: what WP4's spec fold decodes.
		expect(body).toEqual(
			toJson(
				PolicyBindingRecordSchema,
				create(PolicyBindingRecordSchema, first.ok ? first.value : {}),
			),
		);
	});
});

describe("CampPolicy: rollback restores the previous digest", () => {
	it("restore after ENFORCE returns the previously enforced Rail and clears the candidate", async () => {
		const h = harness();
		const a = railFreight(RAIL_A, `sha256:${"1".repeat(64)}`);
		const b = railFreight(RAIL_B, `sha256:${"2".repeat(64)}`);
		await qualifyOnInform(h, a);
		await qualifyOnInform(h, b);
		await h.policy.bind(
			{
				campId: PROD,
				freight: a,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		await h.policy.bind(
			{
				campId: PROD,
				freight: b,
				mode: PolicyMode.INFORM,
				promotionId: promotion("p2"),
			},
			h.ctx,
		);
		await h.policy.bind(
			{
				campId: PROD,
				freight: b,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p3"),
			},
			h.ctx,
		);
		expect((await h.policy.binding(PROD))?.enforcedRailDigest).toBe(RAIL_B);
		const restored = await h.policy.restore(
			{ campId: PROD, promotionId: promotion("p3") },
			h.ctx,
		);
		expect(restored.ok).toBe(true);
		const binding = await h.policy.binding(PROD);
		expect(binding?.enforcedRailDigest).toBe(RAIL_A);
		expect(binding?.candidateRailDigest).toBe("");
		expect(h.authorizer.calls.at(-1)?.action).toBe("rollback");
		// Repeating the restore is a no-op.
		const again = await h.policy.restore(
			{ campId: PROD, promotionId: promotion("p3") },
			h.ctx,
		);
		expect(again).toEqual(restored);
		expect(h.store.events(CD_STREAMS.campSpec(PROD))).toHaveLength(4);
	});

	it("restore after INFORM clears only the candidate", async () => {
		const h = harness();
		await qualifyOnInform(h, railFreight(RAIL_A));
		await h.policy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_A),
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		await h.policy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_B),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p2"),
			},
			h.ctx,
		);
		const restored = await h.policy.restore(
			{ campId: PROD, promotionId: promotion("p2") },
			h.ctx,
		);
		expect(restored.ok && restored.value.enforcedRailDigest).toBe(RAIL_A);
		expect(restored.ok && restored.value.candidateRailDigest).toBe("");
	});

	it("refuses to restore an unknown or superseded promotion", async () => {
		const h = harness();
		const unknown = await h.policy.restore(
			{ campId: PROD, promotionId: promotion("nope") },
			h.ctx,
		);
		expect(!unknown.ok && unknown.reasons[0]?.code).toBe(
			"policy-restore-unknown",
		);
		await h.policy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_A),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		await h.policy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_B),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p2"),
			},
			h.ctx,
		);
		const superseded = await h.policy.restore(
			{ campId: PROD, promotionId: promotion("p1") },
			h.ctx,
		);
		expect(!superseded.ok && superseded.reasons[0]?.code).toBe(
			"policy-restore-superseded",
		);
		expect(!superseded.ok && superseded.reasons[0]?.remediation).toMatch(/p2/u);
	});
});

describe("CampPolicy: refusals", () => {
	it("refuses non-RAIL Freight, a malformed digest, an unspecified mode, a denied or proposal-only principal", async () => {
		const h = harness();
		const bindle = create(FreightRecordSchema, {
			...railFreight(RAIL_A),
			manifest: {
				...railFreight(RAIL_A).manifest,
				subject: FreightSubject.BINDLE,
			},
		});
		const notRail = await h.policy.bind(
			{
				campId: PROD,
				freight: bindle,
				mode: PolicyMode.INFORM,
				promotionId: promotion("p"),
			},
			h.ctx,
		);
		expect(!notRail.ok && notRail.reasons[0]?.code).toBe(
			"policy-bind-not-rail",
		);
		const badDigest = create(FreightRecordSchema, {
			...railFreight(RAIL_A),
			manifest: { ...railFreight(RAIL_A).manifest, declarationHash: "md5:x" },
		});
		const digestRefused = await h.policy.bind(
			{
				campId: PROD,
				freight: badDigest,
				mode: PolicyMode.INFORM,
				promotionId: promotion("p"),
			},
			h.ctx,
		);
		expect(!digestRefused.ok && digestRefused.reasons[0]?.code).toBe(
			"policy-bind-digest-invalid",
		);
		const mode = await h.policy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_A),
				mode: PolicyMode.UNSPECIFIED,
				promotionId: promotion("p"),
			},
			h.ctx,
		);
		expect(!mode.ok && mode.reasons[0]?.code).toBe("policy-bind-mode-invalid");
		h.authorizer.deny.add("rail.promote");
		const denied = await h.policy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_A),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p"),
			},
			h.ctx,
		);
		expect(!denied.ok && denied.reasons[0]?.code).toBe("authz-denied");
		h.authorizer.deny.clear();
		h.authorizer.proposalOnly.add("rail.promote");
		const agent = await h.policy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_A),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p"),
			},
			context(h.time.now, AGENT),
		);
		expect(!agent.ok && agent.reasons[0]?.code).toBe(
			"policy-bind-proposal-only",
		);
		expect(h.store.events(CD_STREAMS.campSpec(PROD))).toHaveLength(0);
		expect(freightId(railFreight(RAIL_A))).toMatch(/^sha256:/u);
	});

	it("rebuilds the binding from the journal alone (replay)", async () => {
		const h = harness();
		await h.policy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_A),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		const fresh = createCampPolicy({
			store: h.store,
			tenant: TENANT,
			now: h.time.now,
			authorizer: h.authorizer,
		});
		expect(await fresh.binding(PROD)).toEqual(await h.policy.binding(PROD));
		expect(await fresh.binding(camp("other"))).toBeUndefined();
	});

	it("survives a concurrent writer on the shared spec stream (CAS retry)", async () => {
		const h = harness();
		h.store.beforeAppend = async () => {
			await h.store.put(CD_STREAMS.campSpec(PROD), CD_EVENTS.DeltaOpened, {
				deltaId: "d1",
				campId: PROD,
			});
		};
		const bound = await h.policy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_A),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx,
		);
		expect(bound.ok).toBe(true);
		expect(
			h.store.events(CD_STREAMS.campSpec(PROD)).map((e) => e.type),
		).toEqual([CD_EVENTS.DeltaOpened, CD_EVENTS.PolicyBindingChanged]);
	});
});

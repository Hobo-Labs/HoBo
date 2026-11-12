// The Rail inform → enforce journey (plan 0024 D24, I23, §10 rows for WP24):
// a new Rail bound INFORM is shadowed while the enforced Rail alone decides;
// divergences are recorded and feed the INFORM node's verification series;
// ENFORCE without a qualified INFORM node is refused; rollback restores the
// previous digest. The gate here is the minimal composition WP6's
// gatekeeper performs: evaluate the enforced pack, and, while a candidate is
// bound, the candidate pack through ShadowRecorder.
import { create, toJson } from "@bufbuild/protobuf";
import { evaluatePolicyPack, type PolicyPack } from "@hobo/contracts";
import type { JsonObject } from "@hobo/core";
import { parsePosturePack, resolvePostureBindings } from "@hobo/policy/posture";
import { describe, expect, it } from "vitest";
import {
	CampManagement,
	ComplianceRecordSchema,
	FreightQualifiedRecordSchema,
	FreightSubject,
	PipelineRecordSchema,
	PolicyMode,
	ReconcileObservationRecordSchema,
	RemediationMode,
	ShadowDecisionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	SHADOW_REQUIRED,
} from "../../src/events.js";
import type { Digest, ShadowRecorder, ShadowVerdict } from "../../src/ports.js";
import {
	createShadowRecorder,
	evaluateCamp,
	governingRailDigest,
} from "../../src/posture/index.js";
import { decode, isJsonObject } from "../../src/posture/journal.js";
import {
	camp,
	digest,
	HOUR,
	observe,
	promotion,
	railDelivery,
	railFreight,
	T0,
} from "./fakes.js";
import { type PostureHarness, postureHarness } from "./harness.js";

const PROD = camp("prod-1");
const OLD_RAIL = digest("a");
const NEW_RAIL = digest("b");

const PERMISSIVE: PolicyPack = { id: "rail-old", version: "1", rules: [] };
const STRICT: PolicyPack = {
	id: "rail-new",
	version: "2",
	rules: [
		{
			id: "no-friday-deploys",
			when: () => true,
			decide: () => ({
				effect: "deny",
				reason: "the new Rail forbids this change",
			}),
		},
	],
};
const PACKS: Readonly<Record<Digest, PolicyPack>> = {
	[OLD_RAIL]: PERMISSIVE,
	[NEW_RAIL]: STRICT,
};

/** The gate's policy step: the enforced Rail decides; the candidate is shadowed and recorded. */
async function gate(
	h: PostureHarness,
	shadow: ShadowRecorder,
	deltaId: string,
	stationRail: Digest,
) {
	const request = {
		subject: { kind: "user", id: "ops@acme" },
		action: "deploy",
		resource: { kind: "camp", id: PROD },
		phase: "promote",
	};
	const enforced =
		governingRailDigest(await h.campPolicy.binding(PROD), stationRail) ??
		stationRail;
	const effect = evaluatePolicyPack({ request, pack: PACKS[enforced] }).decision
		.effect;
	const candidate = await shadow.candidate(PROD);
	let verdict: ShadowVerdict | undefined;
	if (candidate) {
		const shadowEffect = evaluatePolicyPack({
			request,
			pack: candidate.policyPack,
		}).decision.effect;
		await shadow.record(
			create(ShadowDecisionRecordSchema, {
				campId: PROD,
				deltaId,
				enforcedRailDigest: enforced,
				candidateRailDigest: candidate.railDigest,
				enforcedEffect: effect,
				candidateEffect: shadowEffect,
				decidedAt: new Date(h.time.now()).toISOString(),
			}),
			h.ctx(),
		);
		verdict = {
			candidateRailDigest: candidate.railDigest,
			decisionId: `${deltaId}-shadow`,
			effect: shadowEffect,
			diverged: shadowEffect !== effect,
		};
	}
	return { effect, enforced, shadow: verdict };
}

async function qualifyInform(h: PostureHarness, freightId: string) {
	const pipeline = create(PipelineRecordSchema, {
		name: "rail-eu",
		subject: FreightSubject.RAIL,
		nodes: [
			{ name: "shadow", campIds: [PROD], policyMode: PolicyMode.INFORM },
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
		freightId,
		campId: PROD,
		pipeline: "rail-eu",
		node: "shadow",
		verificationId: "v1",
		qualifiedAt: new Date(T0).toISOString(),
	});
	// SAFETY: toJson of a message is a JSON object.
	await h.store.put(
		CD_STREAMS.freight(freightId),
		CD_EVENTS.FreightQualified,
		toJson(FreightQualifiedRecordSchema, qualified) as JsonObject,
	);
}

describe("Rail inform → enforce journey", () => {
	it("shadows while INFORM, refuses ENFORCE until INFORM qualifies, enforces, and rolls back", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		h.rails.byCamp.set(
			PROD,
			railDelivery(OLD_RAIL, [
				{ pack: "tls-baseline", remediation: RemediationMode.INFORM },
			]),
		);
		h.rails.byDigest.set(
			NEW_RAIL,
			railDelivery(NEW_RAIL, [
				{ pack: "tls-strict", remediation: RemediationMode.INFORM },
			]),
		);
		const shadow = createShadowRecorder({
			...h.deps,
			telemetry: h.telemetry,
			resolvePack: async (railDigest) => PACKS[railDigest] ?? PERMISSIVE,
		});
		const freight = railFreight(NEW_RAIL);

		// 1. Before any binding the Station's active Rail decides and nothing is shadowed.
		const before = await gate(h, shadow, "d0", OLD_RAIL);
		expect(before).toEqual({
			effect: "allow",
			enforced: OLD_RAIL,
			shadow: undefined,
		});

		// 2. ENFORCE straight away is refused (I23): no INFORM node has qualified the Rail.
		const early = await h.campPolicy.bind(
			{
				campId: PROD,
				freight,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p-early"),
			},
			h.ctx(),
		);
		expect(!early.ok && early.reasons[0]?.code).toBe(SHADOW_REQUIRED);

		// 3. INFORM: the enforced Rail alone decides; the divergence is recorded.
		expect(
			(
				await h.campPolicy.bind(
					{
						campId: PROD,
						freight,
						mode: PolicyMode.INFORM,
						promotionId: promotion("p1"),
					},
					h.ctx(),
				)
			).ok,
		).toBe(true);
		const shadowed = await gate(h, shadow, "d1", OLD_RAIL);
		expect(shadowed.effect).toBe("allow");
		expect(shadowed.shadow).toMatchObject({
			candidateRailDigest: NEW_RAIL,
			effect: "deny",
			diverged: true,
		});
		expect(
			h.store
				.events(CD_STREAMS.compliance(PROD))
				.filter((e) => e.type === CD_EVENTS.PolicyShadowDecided),
		).toHaveLength(1);

		// 4. Posture evaluates the candidate too; the INFORM node's series see both.
		await observe(h.store, PROD, [
			{
				resource: "api",
				kind: "http-route",
				classification: "pii",
				attributes: { "tls.min_version": "1.3" },
			},
		]);
		await h.service.tick(h.ctx());
		const window = {
			campId: PROD,
			railDigest: NEW_RAIL,
			fromMs: T0,
			toMs: T0 + CD_DEFAULTS.informWindowMs,
		};
		expect(await h.service.noncompliantRatio(window)).toEqual([0]);
		expect(
			(await h.service.shadowDivergence(window)).reduce((a, b) => a + b, 0),
		).toBe(1);

		// 5. After INFORM qualifies upstream, ENFORCE makes it the enforced Rail and the next Delta is decided by it.
		await qualifyInform(h, freight.freightId);
		expect(
			(
				await h.campPolicy.bind(
					{
						campId: PROD,
						freight,
						mode: PolicyMode.ENFORCE,
						promotionId: promotion("p2"),
					},
					h.ctx(),
				)
			).ok,
		).toBe(true);
		const enforcedNow = await gate(h, shadow, "d2", OLD_RAIL);
		expect(enforcedNow).toEqual({
			effect: "deny",
			enforced: NEW_RAIL,
			shadow: undefined,
		});

		// 6. Rollback restores the previous digest: the Station's Rail decides again.
		const restored = await h.campPolicy.restore(
			{ campId: PROD, promotionId: promotion("p2") },
			h.ctx(),
		);
		expect(restored.ok && restored.value.enforcedRailDigest).toBe("");
		expect((await gate(h, shadow, "d3", OLD_RAIL)).effect).toBe("allow");
		expect(h.time.now()).toBeLessThan(T0 + HOUR);
	});

	it("replay reproduces every compliance record from its recorded observation and packs", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		h.rails.byCamp.set(
			PROD,
			railDelivery(OLD_RAIL, [
				{ pack: "tls-baseline", remediation: RemediationMode.INFORM },
			]),
		);
		await observe(h.store, PROD, [
			{
				resource: "api",
				kind: "http-route",
				classification: "pii",
				attributes: { "tls.min_version": "1.0" },
			},
		]);
		await h.service.tick(h.ctx());
		h.time.advance(CD_DEFAULTS.postureNoncompliantIntervalMs);
		await observe(h.store, PROD, [
			{
				resource: "api",
				kind: "http-route",
				classification: "pii",
				attributes: { "tls.min_version": "1.3" },
			},
		]);
		await h.service.tick(h.ctx());
		const recorded = h.store
			.events(CD_STREAMS.compliance(PROD))
			.filter((e) => e.type === CD_EVENTS.ComplianceObserved);
		expect(recorded).toHaveLength(2);
		const packs = (await h.deps.packs(["tls-baseline"])).map((doc) =>
			parsePosturePack(doc),
		);
		for (const event of recorded) {
			const record = decode(ComplianceRecordSchema, event.data);
			if (!record) throw new Error("undecodable compliance record");
			const source = h.store.all.find(
				(entry) => entry.position.toString() === record.observationPosition,
			);
			const data = source?.event.data;
			const observation = decode(
				ReconcileObservationRecordSchema,
				isJsonObject(data) ? data.observation : undefined,
			);
			if (!observation)
				throw new Error("observation not found at recorded position");
			const replayed = evaluateCamp({
				campId: PROD,
				railDigest: record.railDigest,
				candidate: record.candidate,
				packs,
				modes: resolvePostureBindings([
					{ pack: "tls-baseline", remediation: "inform" },
				]),
				observation,
				position: record.observationPosition,
				resolved: undefined,
				management: CampManagement.MANAGED,
				evaluatedAt: record.evaluatedAt,
			});
			expect(replayed.record).toEqual(record);
		}
	});
});

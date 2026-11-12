// Promoted proof: champion-challenger-promotion-contract (HOBO-344), its
// acceptance carried into CD promotion semantics. The can-deploy proof's
// acceptance lives in gate.test.ts ("can-deploy (promoted proof)").
//   shadow       → a candidate Rail in INFORM is evaluated, the enforced Rail serves
//   gated        → promotion persists only through a certified gate decision
//   provenance   → incomplete signed provenance is refused before persistence
//   idempotent   → a repeated promotion changes nothing; it is reversible from the log
//   prod → delta → a proposal-only principal yields a Delta proposal, never an apply
//   region-scoped→ only the targeted Camp's desired state changes
import { definePolicyRule, type PolicyPack } from "@hobo/contracts";
import { describe, expect, it } from "vitest";
import {
	PolicyMode,
	PromotionState,
	type ShadowDecisionRecord,
} from "../../src/_generated/cd_pb.js";
import { createDeployGate } from "../../src/adapters/gatekeeper.js";
import type {
	CampTopology,
	Digest,
	PostureService,
	ShadowRecorder,
} from "../../src/ports.js";
import {
	digest,
	FakeCampPolicy,
	RecordingTelemetry,
	resolvedFor,
} from "./doubles.js";
import { harness } from "./harness.js";
import { AGENT, camp, fid, MemoryEventStore, T0, TENANT } from "./store.js";

const CHAMPION: PolicyPack = { id: "champion", version: "1", rules: [] };
const CHALLENGER: PolicyPack = {
	id: "challenger",
	version: "2",
	rules: [
		definePolicyRule({
			id: "deny-all-promotions",
			when: () => true,
			decide: () => ({ effect: "deny", reason: "challenger is stricter" }),
		}),
	],
};
const CHALLENGER_DIGEST = digest("c4");

const NO_POSTURE: PostureService = {
	compliance: async () => [],
	observeFields: async () => [],
	conflicts: async () => [],
	remediations: async () => [],
	tick: async () => {},
};

function realGate(
	campPolicy: FakeCampPolicy,
	recorded: ShadowDecisionRecord[],
) {
	const shadow: ShadowRecorder = {
		async candidate(campId) {
			const binding = await campPolicy.binding(campId);
			return binding?.candidateRailDigest
				? {
						railDigest: binding.candidateRailDigest as Digest,
						policyPack: CHALLENGER,
					}
				: undefined;
		},
		async record(decision) {
			recorded.push(decision);
		},
	};
	return createDeployGate({
		store: new MemoryEventStore(),
		tenant: TENANT,
		now: () => T0,
		topology: {
			async camps() {
				return [];
			},
			async camp(id): Promise<CampTopology> {
				return {
					campId: id,
					yardId: "y",
					stationId: "st",
					provider: "alpha",
					regions: ["us-east-1"],
					envType: "dev",
					labels: {},
					management: 1,
				};
			},
		},
		windows: {
			async define(w) {
				return { ok: true, value: w };
			},
			async list() {
				return [];
			},
			async override(): Promise<never> {
				throw new Error("not used");
			},
			async evaluate() {
				return {
					open: true,
					rollbackAllowed: true,
					activeFreezes: [],
					overrides: [],
				};
			},
		},
		campPolicy,
		shadow,
		posture: NO_POSTURE,
		resolvePack: async () => CHAMPION,
		stationRail: async () => ({
			railDigest: digest("c0"),
			policyPack: CHAMPION,
		}),
		contracts: async () => ({ deployed: [], candidate: [] }),
		subject: async () => ({ classifications: [], residency: [] }),
		telemetry: new RecordingTelemetry(),
	});
}

describe("champion-challenger-promotion-contract (promoted)", () => {
	it("shadow: the challenger Rail is evaluated in INFORM while the champion decides and serves", async () => {
		const policy = new FakeCampPolicy();
		const recorded: ShadowDecisionRecord[] = [];
		const h = harness({ gate: realGate(policy, recorded) });
		const rail = h.freight.add("r1", { declarationHash: CHALLENGER_DIGEST });
		await policy.bind({
			campId: camp("dev-1"),
			freight: rail,
			mode: PolicyMode.INFORM,
			promotionId: "p",
		});
		h.freight.add("f1");
		const result = await h.service.promote(
			{ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "s" },
			h.ctx(),
		);
		expect(result.ok && result.value.state).toBe(PromotionState.PROMOTED);
		expect(recorded.length).toBeGreaterThan(0);
		expect(
			recorded.every(
				(r) =>
					r.enforcedEffect === "allow" &&
					r.candidateEffect === "deny" &&
					r.diverged,
			),
		).toBe(true);
	});

	it("incomplete signed provenance is refused before anything is persisted", async () => {
		const h = harness({ gate: realGate(new FakeCampPolicy(), []) });
		h.freight.add("f1", {
			provenance: [{ statementDigest: digest("aa"), verified: false } as never],
		});
		const result = await h.service.promote(
			{ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "p" },
			h.ctx(),
		);
		expect(result.ok && result.value.state).toBe(PromotionState.REJECTED);
		expect(h.desired.applied).toHaveLength(0);
	});

	it("idempotent and reversible from the append-only log", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		const seed = h.desired.seed(
			"dev-1",
			"f0",
			resolvedFor("dev-1", "alpha", "f0"),
		);
		const input = {
			freightId: fid("f1"),
			targets: [camp("dev-1")],
			idempotencyKey: "i",
		};
		await h.service.promote(input, h.ctx());
		await h.service.promote(input, h.ctx());
		expect(h.desired.applied).toHaveLength(1);
		await h.service.rollback(
			{ campId: camp("dev-1"), reason: "revert", idempotencyKey: "r" },
			h.ctx(),
		);
		expect((await h.desired.current(camp("dev-1")))?.planHash).toBe(
			seed.planHash,
		);
	});

	it("a proposal-only principal yields a Delta proposal, never an apply (prod → PR delta)", async () => {
		const h = harness();
		h.freight.add("f1");
		const result = await h.service.promote(
			{ freightId: fid("f1"), targets: [camp("prod-1")], idempotencyKey: "pr" },
			h.ctx(AGENT),
		);
		expect(result.ok && result.value.proposal).toBe(true);
		expect([...h.desired.deltas.values()].map((d) => d.delta.proposal)).toEqual(
			[true],
		);
		expect(h.desired.applied).toHaveLength(0);
	});

	it("only the targeted Camp's desired state changes", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		const other = h.desired.seed(
			"dev-2",
			"f0",
			resolvedFor("dev-2", "alpha", "f0"),
		);
		await h.service.promote(
			{ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "x" },
			h.ctx(),
		);
		expect(await h.desired.current(camp("dev-2"))).toEqual(other);
	});
});

// The deploy gate adapter over the real Gatekeeper (D15, D24, D25, I22, I23)
// and the promoted can-deploy-compatibility-gate-contract proof semantics.
import { create } from "@bufbuild/protobuf";
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import {
	type BoundaryContract,
	createBoundaryContract,
	definePolicyRule,
	type PolicyPack,
} from "@hobo/contracts";
import { describe, expect, it } from "vitest";
import {
	ChangeKind,
	type ChangeWindowRecord,
	ComplianceState,
	type DeltaRecord,
	DeltaRecordSchema,
	type FreightRecord,
	PolicyMode,
	type PostureFindingRecord,
	PostureFindingRecordSchema,
	type SetRecord,
	SetRecordSchema,
	type ShadowDecisionRecord,
} from "../../src/_generated/cd_pb.js";
import {
	createDeployGate,
	GATE_REASON,
	PREVIEW_LABEL,
} from "../../src/adapters/gatekeeper.js";
import { OWNERSHIP_CONFLICT } from "../../src/events.js";
import type {
	CampTopology,
	ChangeWindows,
	Digest,
	PlacementSubject,
	PostureService,
	ShadowRecorder,
	TopologyReader,
	WindowEvaluation,
} from "../../src/ports.js";
import { previewCampIdFor } from "../../src/promotion/index.js";
import {
	digest,
	FakeCampPolicy,
	FakeFreight,
	RecordingTelemetry,
	resolvedFor,
} from "./doubles.js";
import { camp, clock, context, MemoryEventStore, T0, TENANT } from "./store.js";

const LENIENT: PolicyPack = { id: "rail.lenient", version: "1", rules: [] };
const STRICT: PolicyPack = {
	id: "rail.strict",
	version: "1",
	rules: [
		definePolicyRule({
			id: "no-alpha-in-prod",
			when: (request) =>
				request.context?.provider === "alpha" &&
				request.context?.envType === "prod",
			decide: () => ({
				effect: "deny",
				reason: "alpha is not approved for prod",
				violations: ["no-alpha-in-prod"],
			}),
		}),
	],
};
const LENIENT_DIGEST = digest("1e");
const STRICT_DIGEST = digest("5a");

const edge = {
	kind: "event",
	producer: "api@1.0.0",
	consumer: "worker@1.4.2",
	channel: "order-events",
	operation: "order.created",
} as const;
const RUNNING = createBoundaryContract({
	id: "orders",
	version: "2.0.0",
	edge,
	requiredLayout: {
		format: "json-schema",
		requiredFields: ["orderId", "tenantId"],
		providedFields: ["orderId", "tenantId"],
	},
});
const ADDITIVE = createBoundaryContract({
	id: "orders",
	version: "3.0.0",
	edge: { ...edge, producer: "api@1.9.0" },
	requiredLayout: {
		format: "json-schema",
		requiredFields: ["orderId", "tenantId"],
		providedFields: ["orderId", "tenantId", "discountCode"],
	},
});
const BREAKING = createBoundaryContract({
	id: "orders",
	version: "3.0.0",
	edge: { ...edge, producer: "api@1.8.0" },
	requiredLayout: {
		format: "json-schema",
		requiredFields: ["orderId"],
		providedFields: ["orderId"],
	},
});

class Windows implements ChangeWindows {
	evaluation: WindowEvaluation = {
		open: true,
		rollbackAllowed: true,
		activeFreezes: [],
		overrides: [],
	};
	readonly calls: string[][] = [];
	async define(window: ChangeWindowRecord) {
		return { ok: true as const, value: window };
	}
	async list() {
		return [];
	}
	async override(): Promise<never> {
		throw new Error("not used");
	}
	async evaluate(input: Parameters<ChangeWindows["evaluate"]>[0]) {
		this.calls.push([input.campId, ...input.windowNames]);
		return this.evaluation;
	}
}

class Shadow implements ShadowRecorder {
	readonly recorded: ShadowDecisionRecord[] = [];
	constructor(private readonly policy: FakeCampPolicy) {}
	async candidate(campId: Parameters<ShadowRecorder["candidate"]>[0]) {
		const binding = await this.policy.binding(campId);
		if (!binding || binding.candidateRailDigest === "") return undefined;
		return {
			// SAFETY: test fixture; the value is the shape the port declares.
			railDigest: binding.candidateRailDigest as Digest,
			policyPack: packFor(binding.candidateRailDigest),
		};
	}
	async record(decision: ShadowDecisionRecord) {
		this.recorded.push(decision);
	}
}

function packFor(railDigest: string): PolicyPack {
	return railDigest === STRICT_DIGEST ? STRICT : LENIENT;
}

class Posture implements PostureService {
	findings: PostureFindingRecord[] = [];
	async conflicts() {
		return this.findings;
	}
	async compliance() {
		return [];
	}
	async observeFields() {
		return [];
	}
	async remediations() {
		return [];
	}
	async tick() {}
}

function setup(
	options: {
		regions?: string[];
		contracts?: {
			deployed?: readonly BoundaryContract[];
			candidate: readonly BoundaryContract[];
		};
		subject?: PlacementSubject;
	} = {},
) {
	const c = clock(T0);
	const store = new MemoryEventStore(c.now);
	const campPolicy = new FakeCampPolicy();
	const shadow = new Shadow(campPolicy);
	const posture = new Posture();
	const windows = new Windows();
	const telemetry = new RecordingTelemetry();
	const topology: TopologyReader = {
		async camps() {
			return [];
		},
		async camp(id) {
			if (id !== "prod-1") return undefined;
			const topo: CampTopology = {
				campId: id,
				yardId: "yard-a",
				stationId: "st-1",
				provider: "alpha",
				regions: options.regions ?? ["us-east-1"],
				envType: "prod",
				labels: { tier: "gold" },
				management: 1,
			};
			return topo;
		},
	};
	const gate = createDeployGate({
		store,
		tenant: TENANT,
		now: c.now,
		topology,
		windows,
		campPolicy,
		shadow,
		posture,
		resolvePack: async (railDigest) => packFor(railDigest),
		stationRail: async () => ({
			railDigest: LENIENT_DIGEST,
			policyPack: LENIENT,
		}),
		contracts: async () =>
			options.contracts
				? {
						deployed: options.contracts.deployed,
						candidate: options.contracts.candidate,
					}
				: { deployed: [], candidate: [] },
		subject: async () =>
			options.subject ?? { classifications: [], residency: [] },
		residencyCatalog: { "us-east-1": ["us"], "eu-central-1": ["eu"] },
		telemetry,
	});
	const freights = new FakeFreight();
	return {
		gate,
		campPolicy,
		shadow,
		posture,
		windows,
		telemetry,
		freights,
		ctx: context(c.now),
	};
}

function input(
	freight: FreightRecord,
	campId = "prod-1",
	changes: DeltaRecord["changes"] = [],
	current = false,
) {
	const resolved: ResolvedDeploymentSet = resolvedFor(
		campId,
		"alpha",
		freight.freightId,
	);
	return {
		intent: "promote" as const,
		delta: create(DeltaRecordSchema, {
			deltaId: "delta_1",
			campId,
			freightId: freight.freightId,
			changes,
			intent: "promote",
		}),
		freight,
		resolved,
		windows: ["business-hours"],
		...currentSet(current, campId),
	};
}

/** The optional `current` field of the gate input. */
type CurrentField = { current?: SetRecord };

/** The optional `current` field: present only when the Camp runs a Set. */
function currentSet(current: boolean, campId: string): CurrentField {
	const value: CurrentField = {};
	if (current)
		value.current = create(SetRecordSchema, { setId: "set_1", campId });
	return value;
}

describe("deploy gate (gatekeeper.ts)", () => {
	it("a shadow divergence is recorded while the enforced decision stands (D24)", async () => {
		const s = setup();
		const freight = s.freights.add("f1");
		const rail = s.freights.add("r1", { declarationHash: STRICT_DIGEST });
		await s.campPolicy.bind({
			campId: camp("prod-1"),
			freight: rail,
			mode: PolicyMode.INFORM,
			promotionId: "p",
		});
		const verdict = await s.gate.evaluate(input(freight), s.ctx);
		expect(verdict.effect).toBe("allow");
		expect(verdict.shadow).toMatchObject({
			candidateRailDigest: STRICT_DIGEST,
			effect: "deny",
			diverged: true,
		});
		expect(s.shadow.recorded).toHaveLength(1);
		expect(s.shadow.recorded[0]).toMatchObject({
			campId: "prod-1",
			enforcedRailDigest: LENIENT_DIGEST,
			candidateRailDigest: STRICT_DIGEST,
			enforcedEffect: "allow",
			candidateEffect: "deny",
			diverged: true,
		});
		expect(s.telemetry.named("hobo.cd.gate.shadow_diverged")).toHaveLength(1);
	});

	it("after ENFORCE the next Delta is decided by the new Rail (I23)", async () => {
		const s = setup();
		const freight = s.freights.add("f1");
		const rail = s.freights.add("r1", { declarationHash: STRICT_DIGEST });
		await s.campPolicy.bind({
			campId: camp("prod-1"),
			freight: rail,
			mode: PolicyMode.ENFORCE,
			promotionId: "p",
		});
		const verdict = await s.gate.evaluate(input(freight), s.ctx);
		expect(verdict.effect).toBe("deny");
		expect(verdict.reasons.map((r) => r.code)).toContain("policy-denied");
		expect(verdict.shadow).toBeUndefined();
	});

	it("refuses a Delta that keeps a recorded ownership conflict, and admits one that changes it (I22)", async () => {
		const s = setup();
		const freight = s.freights.add("f1");
		s.posture.findings = [
			create(PostureFindingRecordSchema, {
				rule: "tls-min",
				resource: "web",
				state: ComplianceState.NONCOMPLIANT,
				ownershipConflict: true,
				observed: "tls1.0",
			}),
		];
		const keeps = await s.gate.evaluate(input(freight), s.ctx);
		expect(keeps.effect).toBe("deny");
		expect(
			keeps.reasons.find((r) => r.code === OWNERSHIP_CONFLICT)?.remediation,
		).toMatch(/Change the declaration of web/);
		const changes = await s.gate.evaluate(
			input(freight, "prod-1", [
				// SAFETY: test fixture; the value is the shape the port declares.
				{ resource: "web", kind: ChangeKind.UPDATE } as never,
			]),
			s.ctx,
		);
		expect(changes.effect).toBe("allow");
	});

	it("evaluates residency against declared Yard regions only, fail-closed", async () => {
		const subject: PlacementSubject = {
			classifications: ["pii"],
			residency: [{ classifications: ["pii"], allowedJurisdictions: ["eu"] }],
		};
		const us = setup({ subject, regions: ["us-east-1"] });
		const denied = await us.gate.evaluate(input(us.freights.add("f1")), us.ctx);
		expect(denied.effect).toBe("deny");
		expect(denied.reasons.map((r) => r.subject)).toContain("residency:prod-1");
		const eu = setup({ subject, regions: ["eu-central-1"] });
		expect(
			(await eu.gate.evaluate(input(eu.freights.add("f1")), eu.ctx)).effect,
		).toBe("allow");
		const none = setup({ subject, regions: [] });
		const undeclared = await none.gate.evaluate(
			input(none.freights.add("f1")),
			none.ctx,
		);
		expect(undeclared.reasons.map((r) => r.code)).toContain(
			GATE_REASON.residencyNoRegion,
		);
	});

	it("can-deploy (promoted proof): a producer that drops a field a running consumer needs is denied with fixes", async () => {
		const s = setup({
			contracts: { deployed: [RUNNING], candidate: [BREAKING] },
		});
		const verdict = await s.gate.evaluate(
			input(s.freights.add("f1"), "prod-1", [], true),
			s.ctx,
		);
		expect(verdict.effect).toBe("deny");
		const contracts = verdict.reasons.filter(
			(r) => r.subject === "contracts:prod-1",
		);
		expect(contracts.length).toBeGreaterThan(0);
		expect(contracts[0]?.remediation.length).toBeGreaterThan(0);
	});

	it("can-deploy (promoted proof): an additive producer change passes", async () => {
		const s = setup({
			contracts: { deployed: [RUNNING], candidate: [ADDITIVE] },
		});
		expect(
			(
				await s.gate.evaluate(
					input(s.freights.add("f1"), "prod-1", [], true),
					s.ctx,
				)
			).effect,
		).toBe("allow");
	});

	it("can-deploy (promoted proof): unknown running versions fail closed when the Camp runs a Set", async () => {
		const s = setup({ contracts: { candidate: [ADDITIVE] } });
		const verdict = await s.gate.evaluate(
			input(s.freights.add("f1"), "prod-1", [], true),
			s.ctx,
		);
		expect(verdict.effect).toBe("deny");
		expect(verdict.reasons[0]?.code).toBe(GATE_REASON.unknownRunningVersions);
		expect(verdict.reasons[0]?.message).toMatch(/unknown running versions/);
		// A first deployment has nothing running to break.
		expect(
			(await s.gate.evaluate(input(s.freights.add("f2")), s.ctx)).effect,
		).toBe("allow");
	});

	it("refuses Freight whose provenance is not verified (trust)", async () => {
		const s = setup();
		const freight = s.freights.add("f1", {
			// SAFETY: test fixture; the value is the shape the port declares.
			provenance: [{ statementDigest: digest("aa"), verified: false } as never],
		});
		const verdict = await s.gate.evaluate(input(freight), s.ctx);
		expect(verdict.effect).toBe("deny");
		expect(verdict.reasons[0]?.code).toBe(GATE_REASON.provenanceUnverified);
	});

	it("passes the window evaluation through without deciding on it", async () => {
		const s = setup();
		s.windows.evaluation = {
			open: false,
			rollbackAllowed: true,
			activeFreezes: ["holiday"],
			overrides: [],
		};
		const verdict = await s.gate.evaluate(input(s.freights.add("f1")), s.ctx);
		expect(verdict.effect).toBe("allow");
		expect(verdict.window?.open).toBe(false);
		expect(s.windows.calls[0]).toEqual(["prod-1", "business-hours"]);
	});

	it("denies an undeclared Camp, and gives a preview Camp its source's topology", async () => {
		const s = setup();
		const unknown = await s.gate.evaluate(
			input(s.freights.add("f1"), "ghost-1"),
			s.ctx,
		);
		expect(unknown.effect).toBe("deny");
		expect(unknown.reasons[0]?.code).toBe(GATE_REASON.campUnknown);
		const preview = previewCampIdFor(TENANT, "prod-1", "pr-1");
		expect(
			(await s.gate.evaluate(input(s.freights.add("f2"), preview), s.ctx))
				.effect,
		).toBe("allow");
		expect(PREVIEW_LABEL).toBe("hobo.cd/preview");
	});

	it("decision ids are deterministic for the same inputs and instant (I8)", async () => {
		const a = setup();
		const b = setup();
		const va = await a.gate.evaluate(input(a.freights.add("f1")), a.ctx);
		const vb = await b.gate.evaluate(input(b.freights.add("f1")), b.ctx);
		expect(va.decisionId).toBe(vb.decisionId);
	});
});

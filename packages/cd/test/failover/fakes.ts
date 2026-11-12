// Failover-only test doubles (WP23): pipelines, placement, topology, rails and
// the traffic shifter. They sit on top of the fan-out fakes.
import { create } from "@bufbuild/protobuf";
import {
	type ApplyResult,
	evaluateResidency,
	type RoutingPlan,
	type RoutingPlanId,
	type RoutingStatus,
	type TrafficRoutingOfferingId,
} from "@hobo/core";
import {
	DepartureAction,
	type FailoverPolicyRecord,
	FailoverPolicyRecordSchema,
	type FanoutRecord,
	type FreightAvailabilityRecord,
	PipelineNodeRecordSchema,
	type PipelineRecord,
	PipelineRecordSchema,
	PlacementCandidateRecordSchema,
	type PlacementDecisionRecord,
	PlacementDecisionRecordSchema,
	type PlacementRecord,
	PlacementRecordSchema,
	type RailDeliveryRecord,
	RailDeliveryRecordSchema,
	RailFailoverRecordSchema,
	type ScoreSnapshotRecord,
	TaintEffect,
	type TolerationRecord,
} from "../../src/_generated/cd_pb.js";
import type {
	CampId,
	CampTopology,
	CdContext,
	Outcome,
	PipelineController,
	PlacementEngine,
	RailDeliveryReader,
	TopologyReader,
	TrafficShifter,
} from "../../src/ports.js";
import type { FakeInventory } from "../fanout/fakes.js";

export class FakePipelines implements PipelineController {
	readonly pipelines = new Map<string, PipelineRecord>();
	define(name: string, node: Readonly<{ fanout: FanoutRecord; failover?: FailoverPolicyRecord }>): void {
		this.pipelines.set(
			name,
			create(PipelineRecordSchema, {
				name,
				bindle: "shop",
				nodes: [
					create(PipelineNodeRecordSchema, {
						name: "prod",
						placement: "web",
						fanout: node.fanout,
						departure: DepartureAction.ORPHAN_DATA,
						failover: node.failover ?? create(FailoverPolicyRecordSchema, {}),
					}),
				],
			}),
		);
	}
	async apply(p: PipelineRecord): Promise<Outcome<PipelineRecord>> {
		return { ok: true, value: p };
	}
	async get(name: string) {
		return this.pipelines.get(name);
	}
	async list() {
		return [...this.pipelines.values()];
	}
	async available(): Promise<readonly FreightAvailabilityRecord[]> {
		return [];
	}
	async tick(): Promise<void> {}
}

/**
 * Placement double that behaves like D20 `decide` over the fake inventory:
 * MANAGED, untainted, residency-passing Camps by id, `exclude` honoured.
 * `ignoreResidency` models a faulty engine for defense-in-depth tests.
 */
export class FakePlacement implements PlacementEngine {
	tolerations: TolerationRecord[] = [];
	ignoreResidency = false;
	readonly calls: Parameters<PlacementEngine["decide"]>[0][] = [];
	private next = 1;
	constructor(private readonly inventory: FakeInventory) {}
	async define(p: PlacementRecord): Promise<Outcome<PlacementRecord>> {
		return { ok: true, value: p };
	}
	async get(name: string) {
		return create(PlacementRecordSchema, { name, tolerations: this.tolerations });
	}
	async reportScores(s: ScoreSnapshotRecord): Promise<Outcome<ScoreSnapshotRecord>> {
		return { ok: true, value: s };
	}
	async decide(input: Parameters<PlacementEngine["decide"]>[0], _ctx: CdContext): Promise<Outcome<PlacementDecisionRecord>> {
		this.calls.push(input);
		const exclude = new Set<string>(input.exclude ?? []);
		const eligible = [...this.inventory.camps.values()]
			.filter((v) => !exclude.has(v.topology.campId))
			.filter((v) => !v.status.taints.some((t) => t.effect === TaintEffect.NO_PLACE || t.effect === TaintEffect.NO_RUN))
			.filter(
				(v) =>
					this.ignoreResidency ||
					input.subject.residency.every((constraint) =>
						v.topology.regions.every((region) => evaluateResidency({ constraint, region }).ok),
					),
			)
			.map((v) => v.topology.campId)
			.sort();
		const chosen = input.count === undefined ? eligible : eligible.slice(0, input.count);
		if (chosen.length === 0) return { ok: false, reasons: [] };
		const decisionId = `redecide-${this.next}`;
		this.next += 1;
		return {
			ok: true,
			value: create(PlacementDecisionRecordSchema, {
				decisionId,
				placement: input.placement,
				pipeline: input.pipeline,
				node: input.node,
				candidates: chosen.map((campId) => create(PlacementCandidateRecordSchema, { campId, selected: true })),
			}),
		};
	}
	async decision(): Promise<PlacementDecisionRecord | undefined> {
		return undefined;
	}
}

export function topologyOf(inventory: FakeInventory): TopologyReader {
	return {
		camps: async (): Promise<readonly CampTopology[]> => [...inventory.camps.values()].map((v) => v.topology),
		camp: async (campId: CampId) => inventory.camps.get(campId)?.topology,
	};
}

export class FakeRails implements RailDeliveryReader {
	rail: RailDeliveryRecord;
	constructor(failover: Readonly<{ automatic?: boolean; maxConcurrent?: number; allowImmediatePurge?: boolean }> = {}) {
		this.rail = create(RailDeliveryRecordSchema, {
			railDigest: "sha256:rail",
			campSets: ["fleet"],
			failover: create(RailFailoverRecordSchema, failover),
		});
	}
	async forStation() {
		return this.rail;
	}
	async forCamp() {
		return this.rail;
	}
}

export class FakeTraffic implements TrafficShifter {
	readonly shifts: { campId: string; plan: RoutingPlan }[] = [];
	realize = true;
	async offerings(): Promise<readonly TrafficRoutingOfferingId[]> {
		return [];
	}
	async shift(input: Readonly<{ campId: CampId; plan: RoutingPlan; signal: AbortSignal }>): Promise<ApplyResult> {
		this.shifts.push({ campId: input.campId, plan: input.plan });
		return { planId: input.plan.planId, provider: "simple", realized: this.realize ? "full" : "none", notes: [] };
	}
	async status(_campId: CampId, planId: RoutingPlanId): Promise<RoutingStatus | null> {
		const known = this.shifts.some((s) => s.plan.planId === planId);
		if (!known) return null;
		return { planId, active: this.realize, realized: this.realize ? "full" : "none", notes: [] };
	}
}

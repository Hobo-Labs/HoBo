// CampInventory conformance (plan 0024 D19, I19). Status is merged from named
// sources; agents report facts but can never make a Camp a failover
// candidate; contradictions and silence taint NO_PLACE automatically.
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	canonicalText,
	check,
	checkTypedRefusal,
	runCdAssertions,
} from "./cd-kit.js";
import type { ScenarioCamp } from "./cd-placement-engine.js";
import {
	CD_CONDITION_STATUS,
	CD_CONDITION_TYPE,
	CD_SIGNAL_SOURCE,
	CD_TAINT_EFFECT,
	type Outcome,
} from "./cd-shapes.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const CAMP_INVENTORY_SUITE = "hobo.cd.camp-inventory/v1";

// public-contract: assertion names of the CampInventory suite.
export const CAMP_INVENTORY_ASSERTIONS = Object.freeze([
	"agentSelfReportNeverAddsNoRun",
	"agentCannotTaintNoRun",
	"operatorNoRunIsRecorded",
	"untaintRemoves",
	"contradictoryClaimTaintsNoPlace",
	"silentCampTaintsNoPlace",
	"claimsNeverRewriteTopology",
	"snapshotIsOrderIndependent",
	"tickIsIdempotent",
] as const);
export type CampInventoryAssertion = (typeof CAMP_INVENTORY_ASSERTIONS)[number];

export type CampStatusLike = Readonly<{
	campId: string;
	conditions: readonly Readonly<{
		type: number;
		status: number;
		source: number;
	}>[];
	claims: readonly Readonly<{ name: string; value: string }>[];
	taints: readonly Readonly<{ key: string; effect: number; source: number }>[];
}>;

export type InventorySnapshotLike = Readonly<{
	digest: string;
	camps: readonly Readonly<{
		topology: Readonly<{ campId: string; regions: readonly string[] }>;
	}>[];
}>;

/** Structural view of CampInventory over harness-built records. */
export interface CampInventoryLike<TCondition, TClaim, TTaint, TCtx> {
	status(campId: string): Promise<CampStatusLike | undefined>;
	observe(
		input: Readonly<{
			campId: string;
			source: number;
			conditions: readonly TCondition[];
			claims: readonly TClaim[];
		}>,
		ctx: TCtx,
	): Promise<Outcome<CampStatusLike>>;
	taint(
		input: Readonly<{ campId: string; taint: TTaint }>,
		ctx: TCtx,
	): Promise<Outcome<CampStatusLike>>;
	untaint(
		input: Readonly<{ campId: string; key: string; effect: number }>,
		ctx: TCtx,
	): Promise<Outcome<CampStatusLike>>;
	snapshot(campSets: readonly string[]): Promise<InventorySnapshotLike>;
	tick(ctx: TCtx): Promise<void>;
}

export interface CampInventoryWorld<TCondition, TClaim, TTaint, TCtx> {
	inventory: CampInventoryLike<TCondition, TClaim, TTaint, TCtx>;
	/** Advance the injected clock. */
	advance(ms: number): void;
	/** Record Station-observed lease activity (contact) for a Camp. */
	contact(campId: string): Promise<void>;
	/** The Camp set holding every scenario Camp. */
	readonly campSet: string;
}

export interface CampInventoryHarness<TCondition, TClaim, TTaint, TCtx> {
	readonly subject: string;
	/** Fresh world with `camps` registered in the given order. */
	create(
		camps: readonly ScenarioCamp[],
	): Promise<CampInventoryWorld<TCondition, TClaim, TTaint, TCtx>>;
	condition(
		type: number,
		status: number,
		source: number,
		reason: string,
	): TCondition;
	claim(name: string, value: string, reportedBy: string): TClaim;
	taint(key: string, effect: number, source: number, reason: string): TTaint;
	/** Context for an operator principal and for an agent principal. */
	ctx(principal: "operator" | "agent"): TCtx;
	/** Silence after which a Camp is not REACHABLE (CD_DEFAULTS: 90 s). */
	readonly unreachableAfterMs: number;
}

function fleet(): readonly ScenarioCamp[] {
	return [
		{
			campId: "camp-1",
			yard: "yard-eu",
			provider: "aws",
			regions: ["eu-west"],
			labels: { tier: "edge" },
		},
		{
			campId: "camp-2",
			yard: "yard-us",
			provider: "gcp",
			regions: ["us-east"],
			labels: { tier: "edge" },
		},
		{
			campId: "camp-3",
			yard: "yard-eu",
			provider: "hetzner",
			regions: ["eu-central"],
			labels: { tier: "edge" },
		},
	];
}

function hasTaint(status: CampStatusLike | undefined, effect: number): boolean {
	return (status?.taints ?? []).some((taint) => taint.effect === effect);
}

export async function runCampInventoryConformance<
	TCondition,
	TClaim,
	TTaint,
	TCtx,
>(
	harness: CampInventoryHarness<TCondition, TClaim, TTaint, TCtx>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<CampInventoryAssertion>> {
	const operator = () => harness.ctx("operator");
	const agent = () => harness.ctx("agent");
	const unreachable = () =>
		harness.condition(
			CD_CONDITION_TYPE.REACHABLE,
			CD_CONDITION_STATUS.FALSE,
			CD_SIGNAL_SOURCE.RECONCILER,
			"agent reports itself unreachable",
		);
	return runCdAssertions<CampInventoryAssertion>(
		CAMP_INVENTORY_SUITE,
		harness.subject,
		{
			agentSelfReportNeverAddsNoRun: async () => {
				const world = await harness.create(fleet());
				for (let i = 0; i < 100; i += 1) {
					await world.contact("camp-1");
					await world.inventory.observe(
						{
							campId: "camp-1",
							source: CD_SIGNAL_SOURCE.RECONCILER,
							conditions: [unreachable()],
							claims: [],
						},
						agent(),
					);
					await world.inventory.tick(operator());
					world.advance(1_000);
				}
				check(
					!hasTaint(
						await world.inventory.status("camp-1"),
						CD_TAINT_EFFECT.NO_RUN,
					),
					"100 agent self-reports produced NO_RUN",
					"NO_RUN needs an operator or Rail-permitted independent signals, one Station-observed (I19, §10 WP22)",
				);
			},
			agentCannotTaintNoRun: async () => {
				const world = await harness.create(fleet());
				const outcome = await world.inventory.taint(
					{
						campId: "camp-1",
						taint: harness.taint(
							"agent",
							CD_TAINT_EFFECT.NO_RUN,
							CD_SIGNAL_SOURCE.RECONCILER,
							"self",
						),
					},
					agent(),
				);
				checkTypedRefusal(outcome, "an agent-sourced NO_RUN taint");
				check(
					!hasTaint(
						await world.inventory.status("camp-1"),
						CD_TAINT_EFFECT.NO_RUN,
					),
					"an agent added NO_RUN",
					"agent sources can never add NO_RUN (D19)",
				);
			},
			operatorNoRunIsRecorded: async () => {
				const world = await harness.create(fleet());
				const outcome = await world.inventory.taint(
					{
						campId: "camp-2",
						taint: harness.taint(
							"maintenance",
							CD_TAINT_EFFECT.NO_RUN,
							CD_SIGNAL_SOURCE.OPERATOR,
							"planned",
						),
					},
					operator(),
				);
				check(
					outcome.ok,
					"an operator NO_RUN taint was refused",
					"operators may taint NO_RUN (governed action camp.taint)",
				);
				check(
					hasTaint(
						await world.inventory.status("camp-2"),
						CD_TAINT_EFFECT.NO_RUN,
					),
					"status lacks the operator's NO_RUN",
					"record the taint on the Camp's status",
				);
			},
			untaintRemoves: async () => {
				const world = await harness.create(fleet());
				await world.inventory.taint(
					{
						campId: "camp-2",
						taint: harness.taint(
							"maintenance",
							CD_TAINT_EFFECT.NO_PLACE,
							CD_SIGNAL_SOURCE.OPERATOR,
							"planned",
						),
					},
					operator(),
				);
				const outcome = await world.inventory.untaint(
					{
						campId: "camp-2",
						key: "maintenance",
						effect: CD_TAINT_EFFECT.NO_PLACE,
					},
					operator(),
				);
				check(outcome.ok, "untaint was refused", "operators may untaint");
				check(
					!(await world.inventory.status("camp-2"))?.taints.some(
						(t) => t.key === "maintenance",
					),
					"the taint is still present",
					"untaint removes the taint",
				);
			},
			contradictoryClaimTaintsNoPlace: async () => {
				const world = await harness.create(fleet());
				await world.contact("camp-1");
				await world.inventory.observe(
					{
						campId: "camp-1",
						source: CD_SIGNAL_SOURCE.RECONCILER,
						conditions: [],
						claims: [harness.claim("region", "us-east", "agent-1")],
					},
					agent(),
				);
				await world.inventory.tick(operator());
				const status = await world.inventory.status("camp-1");
				const consistent = status?.conditions.find(
					(c) => c.type === CD_CONDITION_TYPE.CLAIMS_CONSISTENT,
				);
				check(
					consistent?.status === CD_CONDITION_STATUS.FALSE,
					"CLAIMS_CONSISTENT is not FALSE after a contradicting claim",
					"compare claims with declared topology (D19)",
				);
				check(
					hasTaint(status, CD_TAINT_EFFECT.NO_PLACE),
					"no NO_PLACE taint after a contradicting claim",
					"an inconsistent Camp is tainted NO_PLACE automatically",
				);
			},
			silentCampTaintsNoPlace: async () => {
				const world = await harness.create(fleet());
				await world.contact("camp-3");
				await world.inventory.tick(operator());
				world.advance(harness.unreachableAfterMs + 1);
				await world.inventory.tick(operator());
				const status = await world.inventory.status("camp-3");
				const reachable = status?.conditions.find(
					(c) => c.type === CD_CONDITION_TYPE.REACHABLE,
				);
				check(
					reachable?.status === CD_CONDITION_STATUS.FALSE,
					"REACHABLE is not FALSE after silence",
					"derive REACHABLE from Station-observed lease activity",
				);
				check(
					hasTaint(status, CD_TAINT_EFFECT.NO_PLACE),
					"a silent Camp is not NO_PLACE",
					"unreachable Camps are tainted NO_PLACE automatically (D19)",
				);
				check(
					!hasTaint(status, CD_TAINT_EFFECT.NO_RUN),
					"silence alone produced NO_RUN",
					"NO_RUN needs required_signals independent signals",
				);
			},
			claimsNeverRewriteTopology: async () => {
				const world = await harness.create(fleet());
				await world.inventory.observe(
					{
						campId: "camp-1",
						source: CD_SIGNAL_SOURCE.RECONCILER,
						conditions: [],
						claims: [harness.claim("region", "us-east", "agent-1")],
					},
					agent(),
				);
				await world.inventory.tick(operator());
				const snap = await world.inventory.snapshot([world.campSet]);
				const view = snap.camps.find((c) => c.topology.campId === "camp-1");
				check(
					view?.topology.regions.join(",") === "eu-west",
					`declared regions became ${view?.topology.regions.join(",")}`,
					"claims never change declared topology (I19)",
				);
			},
			snapshotIsOrderIndependent: async () => {
				const a = await harness.create(fleet());
				const b = await harness.create([...fleet()].reverse());
				const sa = await a.inventory.snapshot([a.campSet]);
				const sb = await b.inventory.snapshot([b.campSet]);
				check(
					sa.digest === sb.digest,
					"registration order changed the inventory digest",
					"the snapshot is canonical (I18)",
				);
			},
			tickIsIdempotent: async () => {
				const world = await harness.create(fleet());
				await world.contact("camp-1");
				await world.inventory.tick(operator());
				const once = canonicalText(await world.inventory.status("camp-1"));
				await world.inventory.tick(operator());
				check(
					canonicalText(await world.inventory.status("camp-1")) === once,
					"a second tick changed status",
					"tick is safe to repeat (I12)",
				);
			},
		},
		options,
	);
}

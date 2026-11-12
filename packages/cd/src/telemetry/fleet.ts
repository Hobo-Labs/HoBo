// Fleet and policy metrics (WP19 "Fleet and policy"): pure builders from the
// records the frozen read ports return, plus a collector over those ports.
// Reading through ports (not journal bodies) keeps this module independent of
// how the fan-out, failover, inventory and posture owners lay out their
// streams. Every builder emits a complete gauge set (zeros included) so a
// state that empties is visible, never stale.
//
// - hobo.cd.fanout.camps{state}: Camps per slot state of each RUNNING or
//   HALTED fan-out (pending, in_flight, succeeded, failed, deferred).
// - hobo.cd.failover.count{state}: failovers per FailoverState.
// - hobo.cd.compliance.noncompliant_ratio{rail, control, mode}: share of
//   evaluated Camps under a Rail that are noncompliant, overall (`control=*`)
//   and per control. UNKNOWN counts as noncompliant (fail closed, I5);
//   NOT_APPLICABLE is excluded from the denominator.
// - hobo.cd.policy.shadow_divergence{camp, rail}: shadow divergences of a
//   Camp's candidate (INFORM) Rail over the INFORM window.
// - hobo.cd.camp.condition{camp, condition, status} and
//   hobo.cd.camp.taint{camp, key, effect}: the inventory as gauges, for the
//   yard-world fleet views.
import {
	CampConditionType,
	type CampStatusRecord,
	type ComplianceRecord,
	ComplianceState,
	ConditionStatus,
	type FailoverRecord,
	FailoverState,
	FanoutState,
	type FanoutStatusRecord,
	TaintEffect,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import type {
	CampId,
	CampInventory,
	CampPolicy,
	Digest,
	FailoverController,
	FanoutController,
	OtelMetricPoint,
	PostureSeriesReader,
	PostureService,
} from "../ports.js";
import { CD_METRICS, CICD, HOBO_ATTR } from "./semconv.js";

function gauge(
	name: string,
	value: number,
	atMs: number,
	attributes: Readonly<Record<string, string>>,
	unit = "1",
): OtelMetricPoint {
	return { name, kind: "gauge", value, unit, atMs, attributes };
}

function enumName(
	table: Readonly<Record<number, string>>,
	value: number,
): string {
	return (table[value] ?? "UNSPECIFIED").toLowerCase();
}

// public-contract: fan-out slot states reported by hobo.cd.fanout.camps.
export const FANOUT_SLOT_STATES = Object.freeze([
	"pending",
	"in_flight",
	"succeeded",
	"failed",
	"deferred",
] as const);

export function fanoutCampsPoints(
	statuses: readonly FanoutStatusRecord[],
	atMs: number,
): OtelMetricPoint[] {
	const live = statuses
		.filter(
			(s) => s.state === FanoutState.RUNNING || s.state === FanoutState.HALTED,
		)
		.sort((a, b) => a.fanoutId.localeCompare(b.fanoutId));
	return live.flatMap((s) => {
		const counts: Readonly<
			Record<(typeof FANOUT_SLOT_STATES)[number], number>
		> = {
			pending: s.pending.length,
			in_flight: s.inFlight.length,
			succeeded: s.succeeded.length,
			failed: s.failed.length,
			deferred: s.deferred.length,
		};
		return FANOUT_SLOT_STATES.map((state) =>
			gauge(CD_METRICS.fanoutCamps, counts[state], atMs, {
				[HOBO_ATTR.state]: state,
				[HOBO_ATTR.fanoutId]: s.fanoutId,
				[CICD.pipelineName]: s.pipeline,
				[HOBO_ATTR.pipelineNode]: s.node,
				[HOBO_ATTR.freightId]: s.freightId,
			}),
		);
	});
}

export function failoverCountPoints(
	records: readonly FailoverRecord[],
	atMs: number,
): OtelMetricPoint[] {
	const states = Object.values(FailoverState).filter(
		(v): v is FailoverState => typeof v === "number" && v !== 0,
	);
	return states.map((state) =>
		gauge(
			CD_METRICS.failoverCount,
			records.filter((r) => r.state === state).length,
			atMs,
			{ [HOBO_ATTR.state]: enumName(FailoverState, state) },
		),
	);
}

type Tally = { evaluated: number; noncompliant: number };

function failing(state: ComplianceState): boolean {
	return (
		state === ComplianceState.NONCOMPLIANT ||
		state === ComplianceState.UNKNOWN ||
		state === ComplianceState.UNSPECIFIED
	);
}

export function compliancePoints(
	records: readonly ComplianceRecord[],
	atMs: number,
): OtelMetricPoint[] {
	// Latest evaluation per (camp, rail, mode).
	const latest = new Map<string, ComplianceRecord>();
	for (const r of records) {
		const key = `${r.campId}\u0000${r.railDigest}\u0000${r.candidate}`;
		const prior = latest.get(key);
		if (!prior || r.evaluatedAt >= prior.evaluatedAt) latest.set(key, r);
	}
	const tallies = new Map<string, Tally>();
	const tally = (rail: string, mode: string, control: string, bad: boolean) => {
		const key = `${rail}\u0000${mode}\u0000${control}`;
		const t = tallies.get(key) ?? { evaluated: 0, noncompliant: 0 };
		t.evaluated += 1;
		if (bad) t.noncompliant += 1;
		tallies.set(key, t);
	};
	for (const r of latest.values()) {
		if (r.state === ComplianceState.NOT_APPLICABLE) continue;
		const mode = r.candidate ? "inform" : "enforce";
		tally(r.railDigest, mode, "*", failing(r.state));
		const perControl = new Map<string, boolean>();
		for (const f of r.findings) {
			if (f.state === ComplianceState.NOT_APPLICABLE) continue;
			for (const control of f.controls)
				perControl.set(
					control,
					(perControl.get(control) ?? false) || failing(f.state),
				);
		}
		for (const [control, bad] of perControl)
			tally(r.railDigest, mode, control, bad);
	}
	return [...tallies.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, t]) => {
			const [rail = "", mode = "", control = ""] = key.split("\u0000");
			return gauge(
				CD_METRICS.complianceNoncompliantRatio,
				t.evaluated === 0 ? 0 : t.noncompliant / t.evaluated,
				atMs,
				{
					[HOBO_ATTR.railDigest]: rail,
					[HOBO_ATTR.control]: control,
					"hobo.policy.mode": mode,
				},
			);
		});
}

export function campInventoryPoints(
	statuses: readonly CampStatusRecord[],
	atMs: number,
): OtelMetricPoint[] {
	const points: OtelMetricPoint[] = [];
	for (const s of [...statuses].sort((a, b) =>
		a.campId.localeCompare(b.campId),
	)) {
		for (const c of s.conditions)
			points.push(
				gauge(CD_METRICS.campCondition, 1, atMs, {
					[HOBO_ATTR.campId]: s.campId,
					[HOBO_ATTR.condition]: enumName(CampConditionType, c.type),
					[HOBO_ATTR.conditionStatus]: enumName(ConditionStatus, c.status),
				}),
			);
		for (const t of s.taints)
			points.push(
				gauge(CD_METRICS.campTaint, 1, atMs, {
					[HOBO_ATTR.campId]: s.campId,
					[HOBO_ATTR.taintKey]: t.key,
					[HOBO_ATTR.taintEffect]: enumName(TaintEffect, t.effect),
				}),
			);
	}
	return points;
}

/** The read ports the fleet collector uses (all optional; composed by WP18). */
export type FleetSources = Readonly<{
	fanout?: Pick<FanoutController, "list">;
	failover?: Pick<FailoverController, "list">;
	inventory?: Pick<CampInventory, "list">;
	posture?: Pick<PostureService, "compliance">;
	campPolicy?: Pick<CampPolicy, "binding">;
	postureSeries?: Pick<PostureSeriesReader, "shadowDivergence">;
}>;

export async function collectFleetMetrics(
	sources: FleetSources,
	atMs: number,
): Promise<OtelMetricPoint[]> {
	const points: OtelMetricPoint[] = [];
	if (sources.fanout)
		points.push(...fanoutCampsPoints(await sources.fanout.list(), atMs));
	if (sources.failover)
		points.push(...failoverCountPoints(await sources.failover.list(), atMs));
	const views = sources.inventory ? await sources.inventory.list() : [];
	points.push(
		...campInventoryPoints(
			views.map((v) => v.status),
			atMs,
		),
	);
	const campIds: CampId[] = views
		.map((v) => v.topology.campId)
		.sort((a, b) => a.localeCompare(b));
	if (sources.posture) {
		const records: ComplianceRecord[] = [];
		for (const campId of campIds)
			records.push(...(await sources.posture.compliance(campId)));
		points.push(...compliancePoints(records, atMs));
	}
	if (sources.campPolicy && sources.postureSeries)
		for (const campId of campIds) {
			const binding = await sources.campPolicy.binding(campId);
			const rail = binding?.candidateRailDigest ?? "";
			if (!rail.startsWith("sha256:")) continue;
			// SAFETY: guarded by the sha256: prefix check above.
			const railDigest = rail as Digest;
			const series = await sources.postureSeries.shadowDivergence({
				campId,
				railDigest,
				fromMs: atMs - CD_DEFAULTS.informWindowMs,
				toMs: atMs,
			});
			points.push(
				gauge(
					CD_METRICS.policyShadowDivergence,
					series.reduce((sum, n) => sum + n, 0),
					atMs,
					{ [HOBO_ATTR.campId]: campId, [HOBO_ATTR.railDigest]: rail },
				),
			);
		}
	return points;
}

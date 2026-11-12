// WP19 "Fleet and policy" metrics: hobo.cd.fanout.camps{state},
// hobo.cd.failover.count{state}, hobo.cd.compliance.noncompliant_ratio,
// hobo.cd.policy.shadow_divergence, plus inventory gauges and the
// collect/export/health surface of createCdTelemetry.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampConditionRecordSchema,
	CampConditionType,
	CampStatusRecordSchema,
	ComplianceRecordSchema,
	ComplianceState,
	ConditionStatus,
	FailoverRecordSchema,
	FailoverState,
	FanoutState,
	FanoutStatusRecordSchema,
	PolicyBindingRecordSchema,
	PostureFindingRecordSchema,
	TaintEffect,
	TaintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS } from "../../src/events.js";
import type {
	CampTopology,
	CampView,
	OtelMetricPoint,
	TelemetrySink,
} from "../../src/ports.js";
import {
	CD_ALERT_RULES,
	CD_METRICS,
	CD_SLOS,
	campInventoryPoints,
	collectFleetMetrics,
	compliancePoints,
	createCdTelemetry,
	type FleetSources,
	failoverCountPoints,
	fanoutCampsPoints,
} from "../../src/telemetry/index.js";
import {
	camp,
	context,
	MemoryEventStore,
	T0,
	TENANT,
} from "../authz/memory-store.js";

const RAIL_A = "sha256:aaaa";
const RAIL_B = "sha256:bbbb";

function value(
	points: readonly OtelMetricPoint[],
	attrs: Record<string, string>,
) {
	return points.find((p) =>
		Object.entries(attrs).every(([k, v]) => p.attributes[k] === v),
	)?.value;
}

describe("hobo.cd.fanout.camps{state}", () => {
	it("counts Camps per slot state for live fan-outs only, zeros included", () => {
		const running = create(FanoutStatusRecordSchema, {
			fanoutId: "fo-1",
			pipeline: "web",
			node: "prod",
			freightId: "sha256:f",
			state: FanoutState.RUNNING,
			pending: ["c4", "c5", "c6"],
			inFlight: ["c3"],
			succeeded: ["c1", "c2"],
			deferred: ["c7"],
		});
		const done = create(FanoutStatusRecordSchema, {
			fanoutId: "fo-0",
			state: FanoutState.COMPLETED,
			succeeded: ["c1"],
		});
		const points = fanoutCampsPoints([done, running], T0);
		expect(points).toHaveLength(5);
		expect(
			points.every(
				(p) => p.name === CD_METRICS.fanoutCamps && p.kind === "gauge",
			),
		).toBe(true);
		expect(
			Object.fromEntries(points.map((p) => [p.attributes.state, p.value])),
		).toEqual({
			pending: 3,
			in_flight: 1,
			succeeded: 2,
			failed: 0,
			deferred: 1,
		});
		expect(points[0]?.attributes["hobo.cd.fanout.id"]).toBe("fo-1");
	});
});

describe("hobo.cd.failover.count{state}", () => {
	it("counts failovers per state, every state present", () => {
		const f = (state: FailoverState) =>
			create(FailoverRecordSchema, { failoverId: `${state}`, state });
		const points = failoverCountPoints(
			[
				f(FailoverState.REPLACING),
				f(FailoverState.COMPLETED),
				f(FailoverState.COMPLETED),
			],
			T0,
		);
		expect(points.map((p) => p.attributes.state)).toEqual([
			"proposed",
			"replacing",
			"verifying",
			"shifting",
			"purging",
			"completed",
			"refused",
			"abandoned",
		]);
		expect(value(points, { state: "completed" })).toBe(2);
		expect(value(points, { state: "replacing" })).toBe(1);
		expect(value(points, { state: "refused" })).toBe(0);
	});
});

describe("hobo.cd.compliance.noncompliant_ratio", () => {
	const finding = (state: ComplianceState, controls: string[]) =>
		create(PostureFindingRecordSchema, {
			rule: "r",
			resource: "x",
			state,
			controls,
		});
	const record = (
		campId: string,
		rail: string,
		state: ComplianceState,
		evaluatedAt: string,
		findings = [finding(state, ["AC-2"])],
		candidate = false,
	) =>
		create(ComplianceRecordSchema, {
			campId,
			railDigest: rail,
			state,
			evaluatedAt,
			findings,
			candidate,
		});

	it("is the share of evaluated Camps noncompliant, per Rail and per control", () => {
		const points = compliancePoints(
			[
				// c1 was noncompliant, then compliant: the latest evaluation wins.
				record(
					"c1",
					RAIL_A,
					ComplianceState.NONCOMPLIANT,
					"2026-11-12T00:00:00.000Z",
				),
				record(
					"c1",
					RAIL_A,
					ComplianceState.COMPLIANT,
					"2026-11-12T01:00:00.000Z",
				),
				record(
					"c2",
					RAIL_A,
					ComplianceState.NONCOMPLIANT,
					"2026-11-12T01:00:00.000Z",
					[
						finding(ComplianceState.NONCOMPLIANT, ["AC-2"]),
						finding(ComplianceState.COMPLIANT, ["SC-7"]),
					],
				),
				// UNKNOWN counts as noncompliant (fail closed).
				record(
					"c3",
					RAIL_A,
					ComplianceState.UNKNOWN,
					"2026-11-12T01:00:00.000Z",
					[],
				),
				// NOT_APPLICABLE is excluded from the denominator.
				record(
					"c4",
					RAIL_A,
					ComplianceState.NOT_APPLICABLE,
					"2026-11-12T01:00:00.000Z",
				),
				record(
					"c1",
					RAIL_B,
					ComplianceState.COMPLIANT,
					"2026-11-12T01:00:00.000Z",
					[],
					true,
				),
			],
			T0,
		);
		const ratio = (rail: string, control: string, mode = "enforce") =>
			value(points, {
				"hobo.rail.digest": rail,
				"hobo.policy.control": control,
				"hobo.policy.mode": mode,
			});
		expect(ratio(RAIL_A, "*")).toBeCloseTo(2 / 3, 10);
		expect(ratio(RAIL_A, "AC-2")).toBe(0.5);
		expect(ratio(RAIL_A, "SC-7")).toBe(0);
		expect(ratio(RAIL_B, "*", "inform")).toBe(0);
		expect(
			points.every((p) => p.name === CD_METRICS.complianceNoncompliantRatio),
		).toBe(true);
	});
});

const topology = (campId: string): CampTopology => ({
	campId: camp(campId),
	yardId: "yard-eu",
	stationId: "station-eu",
	provider: "vercel",
	regions: ["eu-west-1"],
	envType: "prod",
	labels: {},
	management: 0,
});

function view(campId: string, reachable: boolean, tainted: boolean): CampView {
	return {
		topology: topology(campId),
		status: create(CampStatusRecordSchema, {
			campId,
			conditions: [
				create(CampConditionRecordSchema, {
					type: CampConditionType.REACHABLE,
					status: reachable ? ConditionStatus.TRUE : ConditionStatus.FALSE,
				}),
			],
			taints: tainted
				? [
						create(TaintRecordSchema, {
							key: "region-down",
							effect: TaintEffect.NO_RUN,
						}),
					]
				: [],
		}),
	};
}

describe("inventory gauges", () => {
	it("report every condition and taint per Camp", () => {
		const points = campInventoryPoints(
			[view("c2", false, true).status, view("c1", true, false).status],
			T0,
		);
		expect(points.map((p) => [p.name, p.attributes])).toEqual([
			[
				CD_METRICS.campCondition,
				{
					"hobo.camp.id": "c1",
					"hobo.camp.condition": "reachable",
					"hobo.camp.condition.status": "true",
				},
			],
			[
				CD_METRICS.campCondition,
				{
					"hobo.camp.id": "c2",
					"hobo.camp.condition": "reachable",
					"hobo.camp.condition.status": "false",
				},
			],
			[
				CD_METRICS.campTaint,
				{
					"hobo.camp.id": "c2",
					"hobo.camp.taint.key": "region-down",
					"hobo.camp.taint.effect": "no_run",
				},
			],
		]);
	});
});

function sources(): FleetSources & { divergenceQueries: unknown[] } {
	const divergenceQueries: unknown[] = [];
	return {
		divergenceQueries,
		fanout: {
			list: async () => [
				create(FanoutStatusRecordSchema, {
					fanoutId: "fo-1",
					state: FanoutState.HALTED,
					failed: ["c2"],
				}),
			],
		},
		failover: { list: async () => [] },
		inventory: {
			list: async () => [view("c1", true, false), view("c2", false, true)],
		},
		posture: {
			compliance: async (campId) => [
				create(ComplianceRecordSchema, {
					campId,
					railDigest: RAIL_A,
					state:
						campId === "c2"
							? ComplianceState.NONCOMPLIANT
							: ComplianceState.COMPLIANT,
					evaluatedAt: "2026-11-12T00:00:00.000Z",
				}),
			],
		},
		campPolicy: {
			binding: async (campId) =>
				create(PolicyBindingRecordSchema, {
					campId,
					enforcedRailDigest: RAIL_A,
					candidateRailDigest: campId === "c1" ? RAIL_B : "",
				}),
		},
		postureSeries: {
			shadowDivergence: async (q) => {
				divergenceQueries.push(q);
				return [0, 2, 1];
			},
		},
	};
}

describe("hobo.cd.policy.shadow_divergence and the collector", () => {
	it("sums a candidate Rail's divergences over the INFORM window", async () => {
		const s = sources();
		const points = await collectFleetMetrics(s, T0);
		expect(
			value(
				points.filter((p) => p.name === CD_METRICS.policyShadowDivergence),
				{
					"hobo.camp.id": "c1",
					"hobo.rail.digest": RAIL_B,
				},
			),
		).toBe(3);
		expect(s.divergenceQueries).toEqual([
			{
				campId: "c1",
				railDigest: RAIL_B,
				fromMs: T0 - CD_DEFAULTS.informWindowMs,
				toMs: T0,
			},
		]);
		const names = new Set(points.map((p) => p.name));
		for (const name of [
			CD_METRICS.fanoutCamps,
			CD_METRICS.failoverCount,
			CD_METRICS.complianceNoncompliantRatio,
			CD_METRICS.policyShadowDivergence,
			CD_METRICS.campCondition,
			CD_METRICS.campTaint,
		])
			expect(names.has(name)).toBe(true);
	});
});

describe("createCdTelemetry collect/export/health", () => {
	it("collects DORA and fleet gauges and exports them through the sink", async () => {
		const exported: OtelMetricPoint[] = [];
		const sink: TelemetrySink = {
			spans: async () => undefined,
			metrics: async (p) => {
				exported.push(...p);
			},
		};
		const telemetry = createCdTelemetry({
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => T0,
			sink,
			fleet: sources(),
		});
		const count = await telemetry.export(context(() => T0));
		expect(count).toBe(exported.length);
		const names = new Set(exported.map((p) => p.name));
		expect(names.has(CD_METRICS.doraDeploymentFrequency)).toBe(true);
		expect(names.has(CD_METRICS.doraChangeFailureRate)).toBe(true);
		expect(names.has(CD_METRICS.fanoutCamps)).toBe(true);
		expect(telemetry.health()).toMatchObject({ ok: true });
	});

	it("reports a failing sink and a failing fleet source in health, never throwing", async () => {
		const attempts: string[] = [];
		const sink: TelemetrySink = {
			spans: async () => undefined,
			metrics: async (p) => {
				attempts.push(p[0]?.name ?? "");
				throw new Error("collector down");
			},
		};
		const telemetry = createCdTelemetry({
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => T0,
			sink,
			fleet: {
				fanout: {
					list: async () => {
						throw new Error("fanout store offline");
					},
				},
			},
		});
		await expect(telemetry.export(context(() => T0))).resolves.toBeGreaterThan(
			0,
		);
		const health = telemetry.health();
		expect(health.ok).toBe(false);
		expect(health.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "exporter", ok: false }),
				expect.objectContaining({ name: "fleet-sources", ok: false }),
				expect.objectContaining({ name: "journal", ok: true }),
			]),
		);
		expect(attempts).toContain(CD_METRICS.exportFailures);
	});

	it("reports an unreadable journal in health", async () => {
		const store = new MemoryEventStore();
		store.readAll = () => {
			throw new Error("journal offline");
		};
		const telemetry = createCdTelemetry({
			store,
			tenant: TENANT,
			now: () => T0,
		});
		await expect(telemetry.export(context(() => T0))).resolves.toBe(0);
		expect(telemetry.health().checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "journal", ok: false }),
			]),
		);
	});
});

describe("alert rules and SLOs", () => {
	it("reference only metrics @hobo/cd emits, with unique names and runbooks", () => {
		const emitted = new Set<string>([
			...Object.values(CD_METRICS),
			"cicd.pipeline.run.errors",
			"cicd.pipeline.run.duration",
		]);
		const names = CD_ALERT_RULES.map((r) => r.name);
		expect(new Set(names).size).toBe(names.length);
		for (const rule of CD_ALERT_RULES) {
			expect(emitted.has(rule.metric)).toBe(true);
			expect(rule.runbook).toMatch(/README\.md#runbook$/u);
		}
		const inform = CD_ALERT_RULES.find(
			(r) => r.name === "CdInformNoncompliantRatioHigh",
		);
		expect(inform?.threshold).toBe(CD_DEFAULTS.informMaxNoncompliantRatio);
		for (const slo of CD_SLOS) {
			expect(slo.objective).toBeGreaterThan(0);
			expect(slo.objective).toBeLessThan(1);
		}
	});
});

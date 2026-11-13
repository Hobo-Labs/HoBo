// The shared suite kit and the structural shapes: telemetry per assertion,
// typed failures, secret detection, and enum mirrors pinned to the generated
// @hobo/cd enums (drift guard for the frozen contract).
import {
	ArtifactKind,
	CampConditionType,
	CampManagement,
	Cohort,
	ConditionStatus,
	FanoutState,
	FanoutStrategy,
	HealthSourceKind,
	ReconcileStatus,
	SignalSource,
	SubscriptionKind,
	TaintEffect,
} from "@hobo/cd";
import {
	assertCdConformance,
	CD_ARTIFACT_KIND,
	CD_CAMP_MANAGEMENT,
	CD_COHORT,
	CD_CONDITION_STATUS,
	CD_CONDITION_TYPE,
	CD_CONFORMANCE_METRIC,
	CD_FANOUT_STATE,
	CD_FANOUT_STRATEGY,
	CD_HEALTH_SOURCE_KIND,
	CD_RECONCILE_STATUS,
	CD_SIGNAL_SOURCE,
	CD_SUBSCRIPTION_KIND,
	CD_TAINT_EFFECT,
	CdConformanceError,
	type CdMetricPoint,
	CdConformanceViolation,
	cdCanonicalText,
	cdFindSecret,
	runCdAssertions,
} from "@hobo/conformance";
import { describe, expect, it } from "vitest";

describe("suite kit", () => {
	it("emits one counter per assertion through the telemetry sink", async () => {
		const points: CdMetricPoint[] = [];
		await runCdAssertions(
			"kit",
			"subject",
			{ good: async () => undefined, bad: async () => Promise.reject(new CdConformanceViolation("broken", "fix it")) },
			{ telemetry: { metrics: async (p) => void points.push(...p) }, now: () => 42 },
		);
		expect(points.map((p) => [p.name, p.attributes.assertion, p.attributes.status, p.atMs])).toEqual([
			[CD_CONFORMANCE_METRIC, "good", "pass", 42],
			[CD_CONFORMANCE_METRIC, "bad", "fail", 42],
		]);
	});
	it("records a thrown subject error as a failure with remediation", async () => {
		const report = await runCdAssertions("kit", "subject", { boom: async () => Promise.reject(new TypeError("nope")) });
		expect(report.failures).toEqual([{ assertion: "boom", detail: "subject threw TypeError: nope", remediation: "return a typed Outcome refusal instead of throwing across the port" }]);
		expect(() => assertCdConformance(report)).toThrow(CdConformanceError);
	});
	it("bounds every assertion so a wedged subject fails instead of hanging", async () => {
		const report = await runCdAssertions("kit", "subject", { hang: () => new Promise<void>(() => undefined) }, { assertionTimeoutMs: 20 });
		expect(report.failures[0]?.detail).toMatch(/did not finish within 20 ms/);
	});
	it("finds credential material and renders bigint and bytes canonically", () => {
		expect(cdFindSecret({ url: "https://user:hunter22@example.com" })).toBeDefined();
		expect(cdFindSecret({ ref: "credentialRef:vault/prod/registry" })).toBeUndefined();
		expect(cdCanonicalText({ b: 1n, a: new Uint8Array([1, 255]) })).toBe('{"a":"bytes:01ff","b":"1n"}');
	});
});

describe("structural shapes match the frozen @hobo/cd enums", () => {
	const mirror = (mirrored: Readonly<Record<string, number>>, generated: Readonly<Record<string, string | number>>) => {
		for (const [name, value] of Object.entries(mirrored)) expect([name, generated[name]]).toEqual([name, value]);
	};
	it.each([
		["ArtifactKind", CD_ARTIFACT_KIND, ArtifactKind],
		["SubscriptionKind", CD_SUBSCRIPTION_KIND, SubscriptionKind],
		["ReconcileStatus", CD_RECONCILE_STATUS, ReconcileStatus],
		["HealthSourceKind", CD_HEALTH_SOURCE_KIND, HealthSourceKind],
		["Cohort", CD_COHORT, Cohort],
		["CampManagement", CD_CAMP_MANAGEMENT, CampManagement],
		["CampConditionType", CD_CONDITION_TYPE, CampConditionType],
		["ConditionStatus", CD_CONDITION_STATUS, ConditionStatus],
		["SignalSource", CD_SIGNAL_SOURCE, SignalSource],
		["TaintEffect", CD_TAINT_EFFECT, TaintEffect],
		["FanoutStrategy", CD_FANOUT_STRATEGY, FanoutStrategy],
		["FanoutState", CD_FANOUT_STATE, FanoutState],
	] as const)("%s", (_name, mirrored, generated) => {
		mirror(mirrored, generated);
	});
});

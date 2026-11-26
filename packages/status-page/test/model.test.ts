import { describe, expect, it } from "vitest";

import {
	createStatusPageProjection,
	DEFAULT_FRESHNESS_BUDGET_MS,
	parseComponentSpec,
	parseStatusScope,
	STATUS_SIGNAL_EVENTS,
	statusEnvelope,
	toStatusPageModel,
} from "../src/index.js";

const SCOPE = parseStatusScope({
	kind: "project",
	id: "shop",
	label: "Project shop",
});

const STREAM = "status:test";

function foldWith(
	events: Parameters<ReturnType<typeof createStatusPageProjection>["fold"]>[0],
) {
	const projection = createStatusPageProjection();
	return projection.fold(events).rows["project:shop"];
}

describe("toStatusPageModel", () => {
	it("renders a fresh component as its measured status", () => {
		const row = foldWith([
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.SloMeasured,
				{
					componentId: "kit-web",
					sloName: "availability",
					attainment: 0.9995,
					target: 0.999,
					measuredAt: "2026-08-17T00:00:00.000Z",
				},
				{
					streamId: STREAM,
					seq: 1,
					ts: "2026-08-17T00:00:00.000Z",
					project: "shop",
				},
			),
		]);
		const model = toStatusPageModel(row, {
			scope: SCOPE,
			evaluatedAt: "2026-08-17T00:05:00.000Z",
		});
		expect(model.components).toHaveLength(1);
		expect(model.components[0]?.status).toBe("operational");
		expect(model.overall.indicator).toBe("none");
		expect(model.overall.description).toBe("All systems operational");
	});

	it("forces stale components to unknown — never stale operational", () => {
		const row = foldWith([
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.SloMeasured,
				{
					componentId: "kit-web",
					sloName: "availability",
					attainment: 1,
					target: 0.999,
					measuredAt: "2026-08-17T00:00:00.000Z",
				},
				{
					streamId: STREAM,
					seq: 1,
					ts: "2026-08-17T00:00:00.000Z",
					project: "shop",
				},
			),
		]);
		const staleAt = new Date(
			Date.parse("2026-08-17T00:00:00.000Z") + DEFAULT_FRESHNESS_BUDGET_MS + 1,
		).toISOString();
		const model = toStatusPageModel(row, {
			scope: SCOPE,
			evaluatedAt: staleAt,
		});
		expect(model.components[0]?.status).toBe("unknown");
		expect(model.components[0]?.delayed).toBe(true);
		expect(model.components[0]?.attainment).toBeUndefined();
		expect(model.overall.indicator).toBe("unknown");
		expect(model.overall.description).toBe("Status delayed / unknown");
		expect(model.freshness.staleComponentIds).toEqual(["kit-web"]);
	});

	it("renders declared components with no signals as unknown", () => {
		const model = toStatusPageModel(undefined, {
			scope: SCOPE,
			evaluatedAt: "2026-08-17T00:00:00.000Z",
			declaredComponents: [
				parseComponentSpec({ id: "kit-web", label: "web", kind: "app-kit" }),
			],
		});
		expect(model.components[0]?.status).toBe("unknown");
		expect(model.overall.indicator).toBe("unknown");
	});

	it("renders an empty scope as unknown, not an empty green page", () => {
		const model = toStatusPageModel(undefined, {
			scope: SCOPE,
			evaluatedAt: "2026-08-17T00:00:00.000Z",
		});
		expect(model.components).toHaveLength(0);
		expect(model.overall.indicator).toBe("unknown");
	});

	it("overlays active incidents onto affected components", () => {
		const now = "2026-08-17T00:10:00.000Z";
		const row = foldWith([
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.SloMeasured,
				{
					componentId: "kit-web",
					sloName: "availability",
					attainment: 1,
					target: 0.999,
					measuredAt: "2026-08-17T00:09:00.000Z",
				},
				{
					streamId: STREAM,
					seq: 1,
					ts: "2026-08-17T00:09:00.000Z",
					project: "shop",
				},
			),
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.IncidentOpened,
				{
					incidentId: "INC-1",
					title: "Checkout down",
					impact: "critical",
					affectedComponents: ["kit-web", "kit-api"],
					currentStatus: "investigating",
				},
				{
					streamId: STREAM,
					seq: 2,
					ts: "2026-08-17T00:09:30.000Z",
					project: "shop",
				},
			),
		]);
		const model = toStatusPageModel(row, { scope: SCOPE, evaluatedAt: now });
		const web = model.components.find((c) => c.spec.id === "kit-web");
		const api = model.components.find((c) => c.spec.id === "kit-api");
		// Fresh operational component worsened by the critical incident.
		expect(web?.status).toBe("major_outage");
		// Component known only from the incident still renders.
		expect(api?.status).toBe("major_outage");
		expect(model.overall.indicator).toBe("critical");
		expect(model.activeIncidents).toHaveLength(1);
	});

	it("shows maintenance for operational components inside an active window", () => {
		const row = foldWith([
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.SloMeasured,
				{
					componentId: "dep-db",
					sloName: "availability",
					attainment: 1,
					target: 0.999,
					measuredAt: "2026-08-18T02:05:00.000Z",
				},
				{
					streamId: STREAM,
					seq: 1,
					ts: "2026-08-18T02:05:00.000Z",
					project: "shop",
				},
			),
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.MaintenanceScheduled,
				{
					maintenanceId: "MTN-1",
					title: "DB upgrade",
					windowStart: "2026-08-18T02:00:00.000Z",
					windowEnd: "2026-08-18T03:00:00.000Z",
					affectedComponents: ["dep-db"],
					expectedImpact: "Reads briefly delayed.",
				},
				{
					streamId: STREAM,
					seq: 2,
					ts: "2026-08-17T00:00:00.000Z",
					project: "shop",
				},
			),
		]);
		const model = toStatusPageModel(row, {
			scope: SCOPE,
			evaluatedAt: "2026-08-18T02:10:00.000Z",
		});
		expect(model.components[0]?.status).toBe("maintenance");
		expect(model.overall.indicator).toBe("maintenance");
	});

	it("moves resolved incidents to recent and drops them after the window", () => {
		const row = foldWith([
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.IncidentOpened,
				{
					incidentId: "INC-1",
					title: "Blip",
					impact: "minor",
					affectedComponents: [],
					currentStatus: "investigating",
				},
				{
					streamId: STREAM,
					seq: 1,
					ts: "2026-08-01T00:00:00.000Z",
					project: "shop",
				},
			),
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.IncidentResolved,
				{ incidentId: "INC-1", resolutionSummary: "Recovered." },
				{
					streamId: STREAM,
					seq: 2,
					ts: "2026-08-01T01:00:00.000Z",
					project: "shop",
				},
			),
		]);
		const recent = toStatusPageModel(row, {
			scope: SCOPE,
			evaluatedAt: "2026-08-10T00:00:00.000Z",
		});
		expect(recent.activeIncidents).toHaveLength(0);
		expect(recent.recentIncidents).toHaveLength(1);
		const later = toStatusPageModel(row, {
			scope: SCOPE,
			evaluatedAt: "2026-09-01T00:00:00.000Z",
		});
		expect(later.recentIncidents).toHaveLength(0);
	});

	it("rejects a non-ISO evaluatedAt", () => {
		expect(() =>
			toStatusPageModel(undefined, { scope: SCOPE, evaluatedAt: "yesterday" }),
		).toThrow(TypeError);
	});

	it("returns frozen models", () => {
		const model = toStatusPageModel(undefined, {
			scope: SCOPE,
			evaluatedAt: "2026-08-17T00:00:00.000Z",
		});
		expect(Object.isFrozen(model)).toBe(true);
		expect(Object.isFrozen(model.components)).toBe(true);
	});
});

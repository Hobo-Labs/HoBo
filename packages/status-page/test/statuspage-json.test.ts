import { describe, expect, it } from "vitest";

import {
	createStatusPageProjection,
	parseStatusScope,
	STATUS_SIGNAL_EVENTS,
	statusEnvelope,
	toStatusPageModel,
	toStatuspageStatus,
	toStatuspageSummary,
} from "../src/index.js";

const SCOPE = parseStatusScope({
	kind: "project",
	id: "shop",
	label: "Project shop",
});

function summaryFor(
	events: Parameters<ReturnType<typeof createStatusPageProjection>["fold"]>[0],
	evaluatedAt: string,
) {
	const projection = createStatusPageProjection();
	const row = projection.fold(events).rows["project:shop"];
	return toStatuspageSummary(
		toStatusPageModel(row, { scope: SCOPE, evaluatedAt }),
		{ pageUrl: "https://status.example.com/project-shop/" },
	);
}

describe("statuspage-v2 compatibility", () => {
	it("emits the summary.json top-level shape", () => {
		const summary = summaryFor([], "2026-08-17T00:00:00.000Z");
		expect(Object.keys(summary).sort()).toEqual([
			"components",
			"incidents",
			"page",
			"scheduled_maintenances",
			"status",
		]);
		expect(summary.page).toEqual({
			id: "project-shop",
			name: "Project shop",
			url: "https://status.example.com/project-shop/",
			time_zone: "Etc/UTC",
			updated_at: "2026-08-17T00:00:00.000Z",
		});
	});

	it("maps unknown to degraded_performance with a delayed description", () => {
		const summary = summaryFor(
			[
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
						streamId: "status:test",
						seq: 1,
						ts: "2026-08-17T00:00:00.000Z",
						project: "shop",
					},
				),
			],
			// Far past the freshness budget.
			"2026-08-17T12:00:00.000Z",
		);
		expect(summary.components[0]?.status).toBe("degraded_performance");
		expect(summary.components[0]?.description).toBe("Status delayed / unknown");
		// Overall indicator degrades to minor — never "none" for unknown.
		expect(summary.status.indicator).toBe("minor");
	});

	it("maps incident lifecycle fields onto the v2 incident shape", () => {
		const summary = summaryFor(
			[
				statusEnvelope(
					STATUS_SIGNAL_EVENTS.IncidentOpened,
					{
						incidentId: "INC-1",
						title: "Checkout latency",
						impact: "major",
						affectedComponents: ["kit-web"],
						currentStatus: "investigating",
					},
					{
						streamId: "status:test",
						seq: 1,
						ts: "2026-08-17T00:00:00.000Z",
						project: "shop",
					},
				),
				statusEnvelope(
					STATUS_SIGNAL_EVENTS.IncidentUpdated,
					{
						incidentId: "INC-1",
						currentStatus: "monitoring",
						body: "Fix deployed, watching.",
					},
					{
						streamId: "status:test",
						seq: 2,
						ts: "2026-08-17T00:20:00.000Z",
						project: "shop",
					},
				),
			],
			"2026-08-17T00:30:00.000Z",
		);
		const incident = summary.incidents[0];
		expect(incident?.status).toBe("monitoring");
		expect(incident?.impact).toBe("major");
		expect(incident?.monitoring_at).toBe("2026-08-17T00:20:00.000Z");
		expect(incident?.resolved_at).toBeNull();
		expect(incident?.incident_updates[0]?.body).toBe("Fix deployed, watching.");
		expect(incident?.page_id).toBe("project-shop");
	});

	it("maps maintenance windows and drops canceled ones", () => {
		const summary = summaryFor(
			[
				statusEnvelope(
					STATUS_SIGNAL_EVENTS.MaintenanceScheduled,
					{
						maintenanceId: "MTN-1",
						title: "DB upgrade",
						windowStart: "2026-08-18T02:00:00.000Z",
						windowEnd: "2026-08-18T03:00:00.000Z",
						affectedComponents: [],
						expectedImpact: "brief delays",
					},
					{
						streamId: "status:test",
						seq: 1,
						ts: "2026-08-17T00:00:00.000Z",
						project: "shop",
					},
				),
				statusEnvelope(
					STATUS_SIGNAL_EVENTS.MaintenanceScheduled,
					{
						maintenanceId: "MTN-2",
						title: "Canceled work",
						windowStart: "2026-08-19T02:00:00.000Z",
						windowEnd: "2026-08-19T03:00:00.000Z",
						affectedComponents: [],
						expectedImpact: "none",
					},
					{
						streamId: "status:test",
						seq: 2,
						ts: "2026-08-17T00:00:00.000Z",
						project: "shop",
					},
				),
				statusEnvelope(
					STATUS_SIGNAL_EVENTS.MaintenanceUpdated,
					{ maintenanceId: "MTN-2", state: "canceled" },
					{
						streamId: "status:test",
						seq: 3,
						ts: "2026-08-17T01:00:00.000Z",
						project: "shop",
					},
				),
			],
			"2026-08-17T02:00:00.000Z",
		);
		expect(summary.scheduled_maintenances).toHaveLength(1);
		expect(summary.scheduled_maintenances[0]?.scheduled_for).toBe(
			"2026-08-18T02:00:00.000Z",
		);
		expect(summary.scheduled_maintenances[0]?.status).toBe("scheduled");
	});

	it("emits the minimal status.json document", () => {
		const status = toStatuspageStatus(
			toStatusPageModel(undefined, {
				scope: SCOPE,
				evaluatedAt: "2026-08-17T00:00:00.000Z",
			}),
		);
		expect(Object.keys(status).sort()).toEqual(["page", "status"]);
	});
});

import { expect, it } from "vitest";
import {
	advanceMaintenanceState,
	createStatusPageProjection,
	type MaintenanceState,
	parseStatusScope,
	STATUS_SIGNAL_EVENTS,
	statusEnvelope,
	toStatusPageModel,
} from "../src/index.js";

const states: MaintenanceState[] = [
	"scheduled",
	"in-progress",
	"completed",
	"canceled",
];
const transitions = {
	scheduled: {
		scheduled: "scheduled",
		"in-progress": "in-progress",
		completed: "completed",
		canceled: "canceled",
	},
	"in-progress": {
		scheduled: "in-progress",
		"in-progress": "in-progress",
		completed: "completed",
		canceled: "canceled",
	},
	completed: {
		scheduled: "completed",
		"in-progress": "completed",
		completed: "completed",
		canceled: "completed",
	},
	canceled: {
		scheduled: "canceled",
		"in-progress": "canceled",
		completed: "canceled",
		canceled: "canceled",
	},
} satisfies Record<
	MaintenanceState,
	Record<MaintenanceState, MaintenanceState>
>;
const timestamp = "2026-08-17T12:00:00.000Z";
const options = (seq: number) => ({
	streamId: "status:maintenance",
	seq,
	ts: timestamp,
	project: "shop",
});
const schedule = (seq: number, id = "MTN-1") =>
	statusEnvelope(
		STATUS_SIGNAL_EVENTS.MaintenanceScheduled,
		{
			maintenanceId: id,
			title: "Upgrade",
			windowStart: "2026-08-17T11:00:00.000Z",
			windowEnd: "2026-08-17T13:00:00.000Z",
			affectedComponents: ["web"],
			expectedImpact: "Read delay",
		},
		options(seq),
	);
const update = (seq: number, state: MaintenanceState, id = "MTN-1") =>
	statusEnvelope(
		STATUS_SIGNAL_EVENTS.MaintenanceUpdated,
		{ maintenanceId: id, state },
		options(seq),
	);

it("keeps completed and canceled maintenance terminal", () => {
	for (const current of states) {
		for (const incoming of states) {
			expect(advanceMaintenanceState(current, incoming)).toBe(
				transitions[current][incoming],
			);
		}
	}
});

it("preserves updates across every placement of a late schedule", () => {
	for (const first of states) {
		for (const second of states) {
			for (const third of states) {
				const updates = [first, second, third];
				let expected: MaintenanceState = "scheduled";
				for (const incoming of updates)
					expected = transitions[expected][incoming];
				for (let scheduleAt = 0; scheduleAt <= updates.length; scheduleAt++) {
					const events = [];
					let seq = 1;
					for (let index = 0; index <= updates.length; index++) {
						if (index === scheduleAt) events.push(schedule(seq++));
						const state = updates[index];
						if (state) events.push(update(seq++, state));
					}
					const row =
						createStatusPageProjection().fold(events).rows["project:shop"];
					expect(row?.maintenances["MTN-1"]?.state).toBe(expected);
				}
			}
		}
	}
});

it("does not show a completed maintenance after its schedule arrives late", () => {
	const measured = statusEnvelope(
		STATUS_SIGNAL_EVENTS.SloMeasured,
		{
			componentId: "web",
			sloName: "availability",
			attainment: 1,
			target: 0.999,
			measuredAt: timestamp,
		},
		options(1),
	);
	const row = createStatusPageProjection().fold([
		measured,
		update(2, "completed"),
		schedule(3),
	]).rows["project:shop"];
	const page = toStatusPageModel(row, {
		scope: parseStatusScope({ kind: "project", id: "shop", label: "Shop" }),
		evaluatedAt: timestamp,
	});
	expect(page.maintenances[0]?.state).toBe("completed");
	expect(page.components[0]?.status).toBe("operational");
});

it("keeps pending updates separate and consumes each on its schedule", () => {
	const firstPass = createStatusPageProjection().fold([
		update(1, "completed", "MTN-1"),
		update(2, "canceled", "MTN-2"),
		schedule(3, "MTN-1"),
	]).rows["project:shop"];
	expect(firstPass?.maintenances["MTN-1"]?.state).toBe("completed");
	expect(firstPass?.pendingMaintenanceStates).toEqual({ "MTN-2": "canceled" });
	const finalPass = createStatusPageProjection().fold([
		update(1, "completed", "MTN-1"),
		update(2, "canceled", "MTN-2"),
		schedule(3, "MTN-1"),
		schedule(4, "MTN-2"),
	]).rows["project:shop"];
	expect(finalPass?.maintenances["MTN-1"]?.state).toBe("completed");
	expect(finalPass?.maintenances["MTN-2"]?.state).toBe("canceled");
	expect(finalPass?.pendingMaintenanceStates).toBeUndefined();
});

it("ignores an invalid update before a maintenance is scheduled", () => {
	const invalid = statusEnvelope(
		STATUS_SIGNAL_EVENTS.MaintenanceUpdated,
		{ maintenanceId: "MTN-1", state: "invalid" },
		options(1),
	);
	const beforeSchedule = createStatusPageProjection().fold([invalid]).rows[
		"project:shop"
	];
	expect(beforeSchedule?.pendingMaintenanceStates).toBeUndefined();
	const row = createStatusPageProjection().fold([invalid, schedule(2)]).rows[
		"project:shop"
	];
	expect(row?.maintenances["MTN-1"]?.state).toBe("scheduled");
	expect(row?.pendingMaintenanceStates).toBeUndefined();
});

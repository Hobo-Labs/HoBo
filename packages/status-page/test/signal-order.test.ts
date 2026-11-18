import { expect, it } from "vitest";
import {
	createStatusPageProjection,
	STATUS_SIGNAL_EVENTS,
	statusEnvelope,
} from "../src/index.js";

const timestamp = (minute: number) =>
	new Date(Date.UTC(2026, 7, 17, 12, minute)).toISOString();
const sample = (
	seq: number,
	minute: number,
	label: string,
	attainment: number,
) =>
	statusEnvelope(
		STATUS_SIGNAL_EVENTS.SloMeasured,
		{
			componentId: "web",
			componentLabel: label,
			sloName: "availability",
			attainment,
			target: 0.99,
			measuredAt: timestamp(minute),
		},
		{ streamId: "status:signals", seq, ts: timestamp(minute), project: "shop" },
	);

it("keeps the latest measurement's label and values across every arrival order", () => {
	const permutations = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	];
	for (const order of permutations) {
		const events = order.map((minute, index) =>
			sample(index + 1, minute, `label-${minute}`, minute === 2 ? 1 : 0.5),
		);
		const component =
			createStatusPageProjection().fold(events).rows["project:shop"]?.components
				.web;
		expect(component).toMatchObject({
			label: "label-2",
			status: "operational",
			lastSignalAt: timestamp(2),
			attainment: 1,
			target: 0.99,
			history: { "2026-08-17": { worst: "major_outage", samples: 3 } },
		});
	}
});

it("uses the last folded measurement when timestamps tie", () => {
	const component = createStatusPageProjection().fold([
		sample(1, 2, "first", 1),
		sample(2, 2, "second", 0.5),
	]).rows["project:shop"]?.components.web;
	expect(component).toMatchObject({
		label: "second",
		status: "major_outage",
		attainment: 0.5,
	});
});

it("ignores malformed optional labels without replacing valid measurements", () => {
	for (const label of [0, false, null, "", [], {}]) {
		const invalid = statusEnvelope(
			STATUS_SIGNAL_EVENTS.SloMeasured,
			{
				componentId: "web",
				componentLabel: label,
				sloName: "availability",
				attainment: 0.5,
				target: 0.99,
				measuredAt: timestamp(3),
			},
			{ streamId: "status:signals", seq: 2, ts: timestamp(3), project: "shop" },
		);
		const component = createStatusPageProjection().fold([
			sample(1, 2, "current", 1),
			invalid,
		]).rows["project:shop"]?.components.web;
		expect(component).toMatchObject({
			label: "current",
			status: "operational",
			lastSignalAt: timestamp(2),
			history: { "2026-08-17": { worst: "operational", samples: 1 } },
		});
	}
});

it("preserves the latest sample over generated measurement orders", () => {
	let seed = 0x136a8c29;
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed >>> 8;
	};
	for (let trial = 0; trial < 100; trial++) {
		const measurements = Array.from({ length: 5 }, (_, index) => ({
			minute: next() % 50,
			label: `trial-${trial}-sample-${index}`,
			attainment: next() % 2 === 0 ? 1 : 0.5,
		}));
		const events = measurements.map((entry, index) =>
			sample(index + 1, entry.minute, entry.label, entry.attainment),
		);
		const expected = measurements.reduce((current, entry) =>
			entry.minute >= current.minute ? entry : current,
		);
		const component =
			createStatusPageProjection().fold(events).rows["project:shop"]?.components
				.web;
		expect(component).toMatchObject({
			label: expected.label,
			attainment: expected.attainment,
			lastSignalAt: timestamp(expected.minute),
			status: expected.attainment === 1 ? "operational" : "major_outage",
			history: { "2026-08-17": { samples: 5 } },
		});
	}
});

it("retains the last known label when a fresh sample omits it", () => {
	const withoutLabel = statusEnvelope(
		STATUS_SIGNAL_EVENTS.SloMeasured,
		{
			componentId: "web",
			sloName: "availability",
			attainment: 0.5,
			target: 0.99,
			measuredAt: timestamp(3),
		},
		{ streamId: "status:signals", seq: 2, ts: timestamp(3), project: "shop" },
	);
	const component = createStatusPageProjection().fold([
		sample(1, 2, "current", 1),
		withoutLabel,
	]).rows["project:shop"]?.components.web;
	expect(component).toMatchObject({
		label: "current",
		status: "major_outage",
		lastSignalAt: timestamp(3),
	});
});

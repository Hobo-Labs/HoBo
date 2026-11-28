import { expect, it } from "vitest";
import {
	createStatusPageProjection,
	type IncidentImpact,
	type IncidentState,
	parseStatusScope,
	STATUS_PAGE_EVENTS,
	STATUS_SIGNAL_EVENTS,
	statusEnvelope,
	toStatusPageModel,
} from "../src/index.js";

const timestamp = "2026-08-17T12:00:00.000Z";
const options = (seq: number) => ({
	streamId: "status:incident",
	seq,
	ts: timestamp,
	project: "shop",
});
const open = (
	seq: number,
	id: string,
	impact: IncidentImpact,
	state: IncidentState = "investigating",
) =>
	statusEnvelope(
		STATUS_SIGNAL_EVENTS.IncidentOpened,
		{
			incidentId: id,
			title: `Incident ${id}`,
			impact,
			affectedComponents: ["web"],
			currentStatus: state,
		},
		options(seq),
	);
const update = (seq: number, id: string, state: IncidentState) =>
	statusEnvelope(
		STATUS_SIGNAL_EVENTS.IncidentUpdated,
		{ incidentId: id, currentStatus: state, body: "Update" },
		options(seq),
	);
const resolve = (seq: number, id: string) =>
	statusEnvelope(
		STATUS_SIGNAL_EVENTS.IncidentResolved,
		{ incidentId: id, resolutionSummary: "Recovered" },
		options(seq),
	);

it("backfills the impact of an incident opened after its update", () => {
	const row = createStatusPageProjection().fold([
		update(1, "INC-1", "monitoring"),
		open(2, "INC-1", "critical"),
	]).rows["project:shop"];
	expect(row?.incidents["INC-1"]).toMatchObject({
		title: "Incident INC-1",
		state: "monitoring",
		impact: "critical",
		affectedComponents: ["web"],
	});
	const page = toStatusPageModel(row, {
		scope: parseStatusScope({ kind: "project", id: "shop", label: "Shop" }),
		evaluatedAt: timestamp,
	});
	expect(page.components[0]?.status).toBe("major_outage");
	expect(page.overall.indicator).toBe("critical");
});

it("backfills a resolved tombstone without reopening it", () => {
	const row = createStatusPageProjection().fold([
		resolve(1, "INC-1"),
		open(2, "INC-1", "major"),
	]).rows["project:shop"];
	expect(row?.incidents["INC-1"]).toMatchObject({
		state: "resolved",
		impact: "major",
		resolvedAt: timestamp,
	});
});

it("keeps the first actual open's impact across duplicates", () => {
	const row = createStatusPageProjection().fold([
		open(1, "INC-1", "minor"),
		update(2, "INC-1", "identified"),
		open(3, "INC-1", "critical"),
	]).rows["project:shop"];
	expect(row?.incidents["INC-1"]).toMatchObject({
		state: "identified",
		impact: "minor",
	});
});

it("backfills every impact without regressing an earlier lifecycle update", () => {
	const states: IncidentState[] = [
		"investigating",
		"identified",
		"monitoring",
		"resolved",
	];
	const impacts: IncidentImpact[] = ["minor", "major", "critical"];
	for (const state of states) {
		for (const impact of impacts) {
			const row = createStatusPageProjection().fold([
				update(1, "INC-1", state),
				open(2, "INC-1", impact),
				open(3, "INC-1", impact === "critical" ? "minor" : "critical"),
			]).rows["project:shop"];
			expect(row?.incidents["INC-1"]?.state).toBe(state);
			expect(row?.incidents["INC-1"]?.impact).toBe(impact);
		}
	}
});

it("keeps pending opens separate and consumes each marker", () => {
	const first = createStatusPageProjection().fold([
		update(1, "INC-1", "identified"),
		resolve(2, "INC-2"),
		open(3, "INC-1", "major"),
	]).rows["project:shop"];
	expect(first?.incidents["INC-1"]?.impact).toBe("major");
	expect(first?.pendingIncidentOpens).toEqual({ "INC-2": true });
	const second = createStatusPageProjection().fold([
		update(1, "INC-1", "identified"),
		resolve(2, "INC-2"),
		open(3, "INC-1", "major"),
		open(4, "INC-2", "critical"),
	]).rows["project:shop"];
	expect(second?.incidents["INC-2"]).toMatchObject({
		state: "resolved",
		impact: "critical",
	});
	expect(second?.pendingIncidentOpens).toBeUndefined();
});

it("recognizes a real open even if its title equals its ID", () => {
	const first = statusEnvelope(
		STATUS_SIGNAL_EVENTS.IncidentOpened,
		{
			incidentId: "INC-1",
			title: "INC-1",
			impact: "minor",
			affectedComponents: ["web"],
			currentStatus: "investigating",
		},
		options(1),
	);
	const row = createStatusPageProjection().fold([
		first,
		open(2, "INC-1", "critical"),
	]).rows["project:shop"];
	expect(row?.incidents["INC-1"]?.impact).toBe("minor");
});

it("backfills incidents first seen in a public update", () => {
	const posted = statusEnvelope(
		STATUS_PAGE_EVENTS.IncidentPosted,
		{ incidentId: "INC-1", currentStatus: "identified", body: "Investigating" },
		options(1),
	);
	const row = createStatusPageProjection().fold([
		posted,
		open(2, "INC-1", "critical"),
	]).rows["project:shop"];
	expect(row?.incidents["INC-1"]).toMatchObject({
		state: "identified",
		impact: "critical",
		updates: [{ body: "Investigating", public: true }],
	});
});

it("keeps lifecycle and first-open impact across generated event sequences", () => {
	const states: IncidentState[] = [
		"investigating",
		"identified",
		"monitoring",
		"resolved",
	];
	const impacts: IncidentImpact[] = ["minor", "major", "critical"];
	for (const first of states) {
		for (const second of states) {
			for (const third of states) {
				const updates = [first, second, third];
				const rank = Math.max(...updates.map((state) => states.indexOf(state)));
				for (const impact of impacts) {
					for (let openAt = 0; openAt <= updates.length; openAt++) {
						const events = [];
						let seq = 1;
						for (let index = 0; index <= updates.length; index++) {
							if (index === openAt) events.push(open(seq++, "INC-1", impact));
							const state = updates[index];
							if (state) events.push(update(seq++, "INC-1", state));
						}
						events.push(
							open(seq, "INC-1", impact === "minor" ? "critical" : "minor"),
						);
						const incident =
							createStatusPageProjection().fold(events).rows["project:shop"]
								?.incidents["INC-1"];
						expect(incident?.state).toBe(states[rank]);
						expect(incident?.impact).toBe(impact);
					}
				}
			}
		}
	}
});

it("merges a late first open's state without regressing the lifecycle", () => {
	const states: IncidentState[] = [
		"investigating",
		"identified",
		"monitoring",
		"resolved",
	];
	for (const previous of states) {
		for (const opened of states) {
			const row = createStatusPageProjection().fold([
				update(1, "INC-1", previous),
				open(2, "INC-1", "critical", opened),
			]).rows["project:shop"];
			const expected =
				states[Math.max(states.indexOf(previous), states.indexOf(opened))];
			expect(row?.incidents["INC-1"]?.state).toBe(expected);
			if (expected === "resolved")
				expect(row?.incidents["INC-1"]?.resolvedAt).toBe(timestamp);
		}
	}
});

it("accepts all states on the first open and ignores duplicate-open state", () => {
	const states: IncidentState[] = [
		"investigating",
		"identified",
		"monitoring",
		"resolved",
	];
	for (const state of states) {
		const row = createStatusPageProjection().fold([
			open(1, "INC-1", "minor", state),
			open(2, "INC-1", "critical", "resolved"),
		]).rows["project:shop"];
		expect(row?.incidents["INC-1"]?.state).toBe(state);
		expect(row?.incidents["INC-1"]?.impact).toBe("minor");
		if (state === "resolved")
			expect(row?.incidents["INC-1"]?.resolvedAt).toBe(timestamp);
	}
});

it("records the resolution time when a late first open advances to resolved", () => {
	const later = "2026-08-17T12:05:00.000Z";
	const lateOpen = statusEnvelope(
		STATUS_SIGNAL_EVENTS.IncidentOpened,
		{
			incidentId: "INC-1",
			title: "Incident INC-1",
			impact: "critical",
			affectedComponents: ["web"],
			currentStatus: "resolved",
		},
		{ ...options(2), ts: later },
	);
	const advanced = createStatusPageProjection().fold([
		update(1, "INC-1", "identified"),
		lateOpen,
	]).rows["project:shop"]?.incidents["INC-1"];
	expect(advanced).toMatchObject({
		state: "resolved",
		openedAt: timestamp,
		updatedAt: later,
		resolvedAt: later,
	});
	const alreadyResolved = createStatusPageProjection().fold([
		resolve(1, "INC-1"),
		lateOpen,
	]).rows["project:shop"]?.incidents["INC-1"];
	expect(alreadyResolved?.resolvedAt).toBe(timestamp);
});

import { describe, expect, it } from "vitest";

import {
	advanceIncidentState,
	advanceMaintenanceState,
	parseComponentSpec,
	parseIncidentRecord,
	parseMaintenanceRecord,
	parseStatusScope,
	STATUS_PAGE_SCHEMA,
	StatusPageParseError,
	worstComponentStatus,
} from "../src/index.js";

describe("status-page domain types", () => {
	it("pins the schema constant", () => {
		expect(STATUS_PAGE_SCHEMA).toBe("hobo.status-page/v1");
	});

	it("parses and freezes a valid scope", () => {
		const scope = parseStatusScope({
			kind: "bindle",
			id: "shop",
			label: "shop status",
		});
		expect(Object.isFrozen(scope)).toBe(true);
	});

	it.each([
		[{ kind: "nope", id: "a", label: "x" }],
		[{ kind: "bindle", id: "Bad Id!", label: "x" }],
		[{ kind: "bindle", id: "", label: "x" }],
		[{ kind: "bindle", id: "a", label: "" }],
		["not an object"],
	])("rejects malformed scopes (%j)", (input) => {
		expect(() => parseStatusScope(input)).toThrow(StatusPageParseError);
	});

	it("rejects component specs with bad kinds or ids", () => {
		expect(() =>
			parseComponentSpec({ id: "ok", label: "ok", kind: "mystery" }),
		).toThrow(StatusPageParseError);
		expect(() =>
			parseComponentSpec({ id: "-bad", label: "ok", kind: "app-kit" }),
		).toThrow(StatusPageParseError);
	});

	it("requires resolvedAt on resolved incidents", () => {
		expect(() =>
			parseIncidentRecord({
				id: "INC-1",
				title: "x",
				state: "resolved",
				impact: "minor",
				affectedComponents: [],
				openedAt: "2026-08-17T00:00:00.000Z",
				updatedAt: "2026-08-17T00:00:00.000Z",
				updates: [],
			}),
		).toThrow(/resolvedAt/);
	});

	it("rejects inverted maintenance windows", () => {
		expect(() =>
			parseMaintenanceRecord({
				id: "MTN-1",
				title: "x",
				state: "scheduled",
				windowStart: "2026-08-18T03:00:00.000Z",
				windowEnd: "2026-08-18T02:00:00.000Z",
				affectedComponents: [],
				expectedImpact: "x",
			}),
		).toThrow(StatusPageParseError);
	});

	it("ranks worst-of with unknown above operational", () => {
		expect(worstComponentStatus(["operational", "unknown"])).toBe("unknown");
		expect(worstComponentStatus(["unknown", "degraded"])).toBe("degraded");
		expect(worstComponentStatus(["major_outage", "degraded"])).toBe(
			"major_outage",
		);
		expect(worstComponentStatus([])).toBe("operational");
	});

	it("state machines are forward-only", () => {
		expect(advanceIncidentState("monitoring", "investigating")).toBe(
			"monitoring",
		);
		expect(advanceIncidentState("identified", "resolved")).toBe("resolved");
		expect(advanceMaintenanceState("in-progress", "scheduled")).toBe(
			"in-progress",
		);
		expect(advanceMaintenanceState("scheduled", "canceled")).toBe("canceled");
	});
});

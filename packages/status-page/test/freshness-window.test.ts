import { expect, it } from "vitest";
import {
	createStatusPageProjection,
	parseStatusScope,
	STATUS_SIGNAL_EVENTS,
	statusEnvelope,
	toStatusPageModel,
} from "../src/index.js";

const scope = parseStatusScope({
	kind: "project",
	id: "shop",
	label: "Project shop",
});
const measuredAt = "2026-08-17T12:00:00.000Z";
const measuredAtMs = Date.parse(measuredAt);
const projection = createStatusPageProjection();
const row = projection.fold([
	statusEnvelope(
		STATUS_SIGNAL_EVENTS.SloMeasured,
		{
			componentId: "web",
			sloName: "availability",
			attainment: 1,
			target: 0.999,
			measuredAt,
		},
		{ streamId: "status:freshness", seq: 1, ts: measuredAt, project: "shop" },
	),
]).rows["project:shop"];

it("only treats a signal as fresh inside its inclusive time window", () => {
	const budgetMs = 15 * 60 * 1000;
	for (const age of [-86_400_000, -1, 0, 1, budgetMs, budgetMs + 1]) {
		const page = toStatusPageModel(row, {
			scope,
			evaluatedAt: new Date(measuredAtMs + age).toISOString(),
			freshnessBudgetMs: budgetMs,
		});
		const fresh = age >= 0 && age <= budgetMs;
		expect(page.components[0]?.delayed).toBe(!fresh);
		expect(page.components[0]?.status).toBe(fresh ? "operational" : "unknown");
		expect(page.components[0]?.attainment).toBe(fresh ? 1 : undefined);
		expect(page.overall.indicator).toBe(fresh ? "none" : "unknown");
		expect(page.freshness.staleComponentIds).toEqual(fresh ? [] : ["web"]);
	}
});

it("maintains freshness for generated clock offsets and budgets", () => {
	let seed = 0x7b10cafe;
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed >>> 8;
	};
	for (let trial = 0; trial < 300; trial++) {
		const age = (next() % 2_000_001) - 1_000_000;
		const budget = next() % 1_000_001;
		const page = toStatusPageModel(row, {
			scope,
			evaluatedAt: new Date(measuredAtMs + age).toISOString(),
			freshnessBudgetMs: budget,
		});
		const fresh = age >= 0 && age <= budget;
		expect(page.components[0]?.delayed).toBe(!fresh);
		expect(page.components[0]?.status).toBe(fresh ? "operational" : "unknown");
	}
});

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createCodegenReport,
	exitCodeForReport,
	parseCodegenStatus,
	reportToJson,
} from "../src/types.js";

describe("parseCodegenStatus", () => {
	it("accepts the three canonical statuses", () => {
		expect(parseCodegenStatus("CLEAN")).toBe("CLEAN");
		expect(parseCodegenStatus("DRIFT")).toBe("DRIFT");
		expect(parseCodegenStatus("ERROR")).toBe("ERROR");
	});

	it("rejects anything else (parse, don't validate)", () => {
		expect(() => parseCodegenStatus("clean")).toThrow(
			"invalid CodegenStatus: clean",
		);
		expect(() => parseCodegenStatus("")).toThrow(/invalid CodegenStatus/);
	});
});

describe("createCodegenReport", () => {
	it("defaults drift and cueViolations to empty frozen arrays", () => {
		const report = createCodegenReport({ status: "CLEAN", durationMs: 0 });
		expect(report.drift).toEqual([]);
		expect(report.cueViolations).toEqual([]);
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.drift)).toBe(true);
		expect(Object.isFrozen(report.cueViolations)).toBe(true);
	});

	it("copies input arrays so later caller mutation cannot leak in", () => {
		const drift = [{ path: "core/a_pb.ts", kind: "changed" as const }];
		const report = createCodegenReport({
			status: "DRIFT",
			drift,
			durationMs: 1,
		});
		drift.push({ path: "core/b_pb.ts", kind: "added" });
		expect(report.drift).toHaveLength(1);
	});

	it("rejects negative durations", () => {
		expect(() =>
			createCodegenReport({ status: "CLEAN", durationMs: -1 }),
		).toThrow("durationMs must be >= 0");
	});
});

describe("exitCodeForReport", () => {
	it("maps CLEAN to 0 and both failure statuses to 1", () => {
		expect(
			exitCodeForReport(
				createCodegenReport({ status: "CLEAN", durationMs: 0 }),
			),
		).toBe(0);
		expect(
			exitCodeForReport(
				createCodegenReport({ status: "DRIFT", durationMs: 0 }),
			),
		).toBe(1);
		expect(
			exitCodeForReport(
				createCodegenReport({ status: "ERROR", durationMs: 0 }),
			),
		).toBe(1);
	});
});

describe("reportToJson", () => {
	it("emits a single newline-terminated JSON line with only envelope fields", () => {
		const report = createCodegenReport({
			status: "DRIFT",
			drift: [{ path: "core/x_pb.ts", kind: "removed" }],
			cueViolations: [
				{ package: "core", constraint: "envelope.cue", message: "boom" },
			],
			durationMs: 7,
		});
		const json = reportToJson(report);
		expect(json.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(json);
		expect(Object.keys(parsed).sort()).toEqual([
			"cueViolations",
			"drift",
			"durationMs",
			"status",
		]);
		expect(parsed.drift).toEqual([{ path: "core/x_pb.ts", kind: "removed" }]);
		expect(parsed.cueViolations).toEqual([
			{ package: "core", constraint: "envelope.cue", message: "boom" },
		]);
	});

	it("matches the shape of the package's golden CLEAN report fixture", async () => {
		const goldenPath = fileURLToPath(
			new URL(
				"../data-models/fixtures/valid/clean-report.json",
				import.meta.url,
			),
		);
		const golden = JSON.parse(await readFile(goldenPath, "utf8"));
		const produced = JSON.parse(
			reportToJson(
				createCodegenReport({
					status: "CLEAN",
					durationMs: golden.durationMs,
				}),
			),
		);
		expect(produced).toEqual(golden);
	});
});

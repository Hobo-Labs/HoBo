import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/json.js";
import { sloFixture } from "./slo-fixture.js";

const cue =
	process.env.HOBO_CUE_BIN ||
	fileURLToPath(
		new URL(
			`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
			import.meta.url,
		),
	);
const schema = fileURLToPath(
	new URL("../data-models/slo.cue", import.meta.url),
);
const directory = mkdtempSync(join(tmpdir(), "hobo-slo-cue-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let sequence = 0;
function check(document: JsonValue) {
	const path = join(directory, `${++sequence}.json`);
	writeFileSync(path, JSON.stringify(document));
	return spawnSync(
		cue,
		["vet", "-c", "-d", "#SloDefinitionRecord", schema, path],
		{ encoding: "utf8", timeout: 10_000 },
	);
}
const value = sloFixture();
const calendar = {
	duration: "1M",
	isRolling: false,
	calendar: { startTime: "2026-01-01T00:00:00", timeZone: "America/Chicago" },
};
describe("SLO CUE contract", () => {
	it.each([
		value,
		{
			...value,
			spec: {
				...value.spec,
				timeWindow: calendar,
				budgetingMethod: "Timeslices",
				objectives: [
					{
						displayName: "availability",
						target: 0.99,
						timeSliceWindow: "5m",
						timeSliceTarget: 0.9,
					},
				],
			},
		},
		{
			...value,
			spec: {
				...value.spec,
				budgetingMethod: "RatioTimeslices",
				objectives: [
					{ displayName: "availability", target: 0.99, timeSliceWindow: "5m" },
				],
			},
		},
	])("accepts complete definitions %#", (document) => {
		const result = check(document);
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
	it.each([
		{
			...value,
			spec: { ...value.spec, timeWindow: { duration: "1M", isRolling: true } },
		},
		{
			...value,
			spec: { ...value.spec, timeWindow: { duration: "1d", isRolling: false } },
		},
		{ ...value, spec: { ...value.spec, budgetingMethod: "Timeslices" } },
		{
			...value,
			spec: {
				...value.spec,
				objectives: [{ displayName: "availability", target: 1.1 }],
			},
		},
		{ ...value, extra: "unsupported" },
	])("rejects incomplete definitions %#", (document) => {
		const result = check(document);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
	});
});

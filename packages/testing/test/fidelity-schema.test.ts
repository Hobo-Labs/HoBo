import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const cue =
	process.env.HOBO_CUE_BIN ||
	fileURLToPath(
		new URL(
			`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
			import.meta.url,
		),
	);
const schema = fileURLToPath(
	new URL("../data-models/test_harness.cue", import.meta.url),
);
const directory = mkdtempSync(join(tmpdir(), "hobo-fidelity-cue-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const path = join(directory, "report.json");
const report = {
	by_fidelity: { real: 0, simulated: 1, mocked: 0, "camp-only": 0 },
	asserted_against: [{ alias: "api", fidelity: "simulated" }],
};
function check(claim: boolean) {
	writeFileSync(
		path,
		JSON.stringify({ ...report, prod_readiness_claimable: claim }),
	);
	return spawnSync(
		cue,
		["vet", "-c", "-d", "#FidelityReportRecord", schema, path],
		{
			encoding: "utf8",
			timeout: 10_000,
		},
	);
}

describe("fidelity CUE contract", () => {
	it("accepts access telemetry without a readiness claim", () => {
		expect(check(false).status).toBe(0);
	});
	it("rejects a readiness claim based only on simulated access", () => {
		const result = check(true);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
	});
});

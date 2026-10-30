import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cue = join(
	root,
	".tools",
	"cue",
	"v0.14.0",
	process.platform === "win32" ? "cue.exe" : "cue",
);
const schema = join(packageRoot, "data-models/provider_hetzner.cue");
describe("hosting price evidence CUE contract", () => {
	it("accepts an explicitly estimated catalog rate", () => {
		const result = spawnSync(
			cue,
			[
				"vet",
				"-d",
				"#CostFact",
				schema,
				join(packageRoot, "contracts/hosting-price/estimate.json"),
			],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr || result.error?.message).toBe(0);
	});
	it("rejects certifying a positive rate as verified zero", () => {
		const result = spawnSync(
			cue,
			[
				"vet",
				"-d",
				"#CostFact",
				schema,
				join(packageRoot, "contracts/hosting-price/false-zero.json"),
			],
			{ encoding: "utf8" },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("marginalPrice");
	});
});

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBudgetPolicyJson } from "@hobo/core";
import { describe, expect, it } from "vitest";

describe("hosting shared policy CUE/runtime parity", () => {
	it.each([
		"valid-shared-policy",
		"invalid-shared-policy-control",
	])("validates actual %s against the shared definition", (name) => {
		const file = new URL(
			`../contracts/hosting-budget-fixtures/${name}.json`,
			import.meta.url,
		);
		const cue =
			process.env.HOBO_CUE_BIN ??
			fileURLToPath(
				new URL(
					`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
					import.meta.url,
				),
			);
		const result = spawnSync(
			cue,
			[
				"vet",
				"-d",
				"#BudgetPolicyRecord",
				fileURLToPath(
					new URL("../../core/data-models/budget_policy.cue", import.meta.url),
				),
				fileURLToPath(file),
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		if (result.error) throw result.error;
		const valid = name.startsWith("valid-");
		expect(result.status, result.stderr).toBe(valid ? 0 : 1);
		const parse = () => parseBudgetPolicyJson(readFileSync(file, "utf8"));
		if (valid) expect(parse).not.toThrow();
		else expect(parse).toThrow();
	});
});

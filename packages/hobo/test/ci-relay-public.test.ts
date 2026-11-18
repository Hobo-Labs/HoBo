import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCiRelayDeploy } from "../src/index.js";

describe("public relay delivery API", () => {
	it.each([
		{ team: "fixture-private-team" },
		{ set: ["INFISICAL_PROJECT_ID=fixture-private-project"] },
		{ provision: true },
		{ adopt: true },
	])("refuses legacy options before any provider I/O", async (values) => {
		const result = await runCiRelayDeploy({
			cwd: "/fixture",
			values: { ref: "main", sha: "a".repeat(40), ...values },
			env: {},
			emitProgress: () => {},
		});
		expect(result.code).toBe("HOBO_CI_MANAGED_REQUIRED");
		expect(JSON.stringify(result)).not.toContain("fixture-private");
	});

	it("refuses a legacy transport before calling it", async () => {
		const fetch = vi.fn(async () => {
			throw new Error("unexpected provider I/O");
		});
		const result = await runCiRelayDeploy({
			cwd: "/fixture",
			values: { ref: "main", sha: "a".repeat(40) },
			env: {},
			fetch,
			emitProgress: () => {},
		});
		expect(result.code).toBe("HOBO_CI_MANAGED_REQUIRED");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("requires a pin before selecting any provider for compatible options", async () => {
		const result = await runCiRelayDeploy({
			cwd: "/fixture",
			values: { ref: "main" },
			env: {},
			emitProgress: () => {},
		});
		expect(result.code).toBe("HOBO_CI_MANAGED_SOURCE_INVALID");
	});

	it("retains the package-root import for an external consumer", () => {
		const external = mkdtempSync(join(tmpdir(), "hobo-external-api-"));
		try {
			const scope = join(external, "node_modules", "@hobo");
			mkdirSync(scope, { recursive: true });
			symlinkSync(
				resolve(import.meta.dirname, ".."),
				join(scope, "hobo"),
				"dir",
			);
			const program = `
				import { runCiRelayDeploy } from "@hobo/hobo";
				let calls = 0;
				const result = await runCiRelayDeploy({cwd: "/fixture", values: {ref: "main", team: "fixture-private-team"}, env: {}, fetch: async () => {calls++; throw new Error("unexpected");}, emitProgress: () => {}});
				process.stdout.write(JSON.stringify({code: result.code, calls}));
			`;
			const child = spawnSync(
				process.execPath,
				["--input-type=module", "-e", program],
				{ cwd: external, encoding: "utf8", timeout: 30_000 },
			);
			expect(child.status, child.stderr).toBe(0);
			expect(JSON.parse(child.stdout)).toEqual({
				code: "HOBO_CI_MANAGED_REQUIRED",
				calls: 0,
			});
		} finally {
			rmSync(external, { recursive: true, force: true });
		}
	});
});

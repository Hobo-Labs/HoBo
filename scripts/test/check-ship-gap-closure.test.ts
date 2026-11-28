import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("check-ship-gap-closure", () => {
	it("exits 0 against the real residual ledger and remediation artifacts", () => {
		const script = join(root, "scripts/check-ship-gap-closure.mts");
		assert.ok(existsSync(script), "ship-gap-closure script must exist");

		const result = spawnSync(process.execPath, ["--import", "tsx", script], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /ship-gap-closure: OK/);
		assert.match(result.stdout, /residual IDs present/);
	});

	it("residual ledger lists every required human residual ID as open (not fixed)", () => {
		const residual = readFileSync(
			join(root, "docs/design/instances/residual-human-blockers-2026-07-30.md"),
			"utf8",
		);
		for (const id of [
			"H-V1",
			"H-O2",
			"H-O3",
			"H-O4",
			"H-E1b",
			"H-E3b",
			"H-E5",
			"H-E6",
			"H-T1",
		]) {
			assert.match(residual, new RegExp(`\\b${id}\\b`));
		}
		assert.match(residual, /Agents must not mark these fixed/i);
		assert.match(residual, /does \*\*not\*\* claim H-V1 fixed/i);
	});

	it("product CLI bin is only on @hobo/hobo (dual-bin resolved)", () => {
		// SAFETY: assertion to `JSON.parse( readFileSync(join(root, "packages/cli/package.json"), "utf8"), ) as { bin?: unknown }` is required at this boundary.
		const cli = JSON.parse(
			readFileSync(join(root, "packages/cli/package.json"), "utf8"),
		) as { bin?: unknown };
		// SAFETY: assertion to `JSON.parse( readFileSync(join(root, "packages/hobo/package.json"), "utf8"), ) as { bin?: { hobo?: string } }` is required at this boundary.
		const hobo = JSON.parse(
			readFileSync(join(root, "packages/hobo/package.json"), "utf8"),
		) as { bin?: { hobo?: string } };
		assert.equal(cli.bin, undefined);
		assert.ok(hobo.bin?.hobo);
	});
});

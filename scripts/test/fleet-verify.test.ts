/**
 * `fleet:verify`: every outcome through `fleet:outcome`, one object each, in
 * table order, written to `fleet-verification.json`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OUTCOMES, type VerificationRecord } from "../fleet-outcome.mts";
import { outcomeIds, verifyOutcomes } from "../fleet-verify.mts";

const repoRoot = join(import.meta.dirname, "..", "..");
const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function passed(id: string): VerificationRecord {
	return {
		id,
		pass: true,
		command: "true",
		evidence: ["exit 0: true"],
		measured: { commands_run: 1 },
		fallbacks: [],
	};
}

describe("outcomeIds", () => {
	it("covers every outcome except the deferred ones by default", () => {
		const ids = outcomeIds({});
		expect(ids).toHaveLength(OUTCOMES.length - 2);
		expect(ids).not.toContain("O21");
		expect(ids).not.toContain("O23");
		expect(ids[0]).toBe("O1");
	});

	it("includes the deferred outcomes when asked", () => {
		expect(outcomeIds({ includeDeferred: true })).toHaveLength(OUTCOMES.length);
	});

	it("runs only the ids given, and refuses an unknown one", () => {
		expect(outcomeIds({ ids: ["O26", "O1"] })).toEqual(["O26", "O1"]);
		expect(() => outcomeIds({ ids: ["O99"] })).toThrow(/O99/u);
	});
});

describe("verifyOutcomes", () => {
	it("returns one object per outcome, in order, from the runner", () => {
		const ran: string[] = [];
		const records = verifyOutcomes(["O1", "O26"], (id) => {
			ran.push(id);
			return passed(id);
		});
		expect(ran).toEqual(["O1", "O26"]);
		expect(records.map((record) => record.id)).toEqual(["O1", "O26"]);
		expect(records.every((record) => record.pass)).toBe(true);
	});

	it("records an outcome that printed nothing, or another id, as failed", () => {
		const records = verifyOutcomes(["O1", "O26"], (id) =>
			id === "O1" ? undefined : passed("O7"),
		);
		expect(records).toEqual([
			{
				id: "O1",
				pass: false,
				command: "pnpm run fleet:vocabulary",
				evidence: ["fleet:outcome printed no verification object"],
				measured: {},
				fallbacks: [],
			},
			expect.objectContaining({ id: "O26", pass: false }),
		]);
	});
});

describe("fleet:verify command", () => {
	it("runs each outcome through fleet:outcome and writes fleet-verification.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-fleet-verify-"));
		made.push(dir);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				join(repoRoot, "scripts/fleet-verify.mts"),
				`--root=${dir}`,
				"--ids=O6,O7",
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		// SAFETY: the command's own report file.
		const written = JSON.parse(
			readFileSync(join(dir, "fleet-verification.json"), "utf8"),
		) as VerificationRecord[];
		expect(written.map((record) => [record.id, record.pass])).toEqual([
			["O6", false],
			["O7", false],
		]);
		expect(written[0]?.evidence).toContain(
			"missing: packages/fleet/test/membership/generation.test.ts",
		);
		expect(Object.keys(written[0] ?? {})).toEqual([
			"id",
			"pass",
			"command",
			"evidence",
			"measured",
			"fallbacks",
		]);
	});
});

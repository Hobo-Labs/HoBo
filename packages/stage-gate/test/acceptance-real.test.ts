/**
 * The real ai-bdd lane of the release gate (ADR-0172), the provider side of
 * contracts/pacts/stage-gate-ai-bdd-report.pact.json. Selected by setting
 * HOBO_AI_BDD_CMD; once selected it fails, never skips, when anything it
 * needs is missing or the command cannot run:
 *
 * - HOBO_AI_BDD_CMD: the ai-bdd argv as JSON, e.g.
 *   '["node","--conditions=source","<ai-bdd>/packages/cli/src/bin.ts","-c","<test config>"]'
 * - HOBO_AI_BDD_PROJECT: a project whose committed plans and recordings replay
 *   with no agent, with its verdict cache (.ai-bdd/cache/) present
 * - HOBO_AI_BDD_STALE_DOC: one of its docs (relative path) for the negative
 *   control; it is edited for one gate run and restored byte for byte
 *
 * Run: pnpm --filter @hobo/stage-gate run test:real (the scripts' commands:
 * vitest run test/acceptance-real.test.ts in this package).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defineReleaseGate } from "../src/definition.js";
import {
	parseStageGateRecord,
	serializeStageGateRecord,
} from "../src/parse.js";
import { runStageGate } from "../src/runner.js";
import type { RunStageGateResult } from "../src/types.js";

const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
const SELECTED = process.env.HOBO_AI_BDD_CMD !== undefined;
const TIMEOUT = 600_000;

function required(name: string): string {
	const value = process.env[name] ?? "";
	if (value === "") {
		throw new Error(
			`${name} must be set when HOBO_AI_BDD_CMD selects the real ai-bdd lane`,
		);
	}
	return value;
}

function recordText(result: RunStageGateResult): string {
	return JSON.stringify(serializeStageGateRecord(result.record), null, 2);
}

describe.skipIf(!SELECTED)("the release gate against a real ai-bdd", () => {
	it(
		"replays with zero model calls and records the digest of report.json",
		async () => {
			const project = resolve(REPO_ROOT, required("HOBO_AI_BDD_PROJECT"));
			const result = await runStageGate(defineReleaseGate(), {
				cwd: REPO_ROOT,
			});
			expect(result.record.status, recordText(result)).toBe("passed");
			expect(result.exitCode).toBe(0);
			const report = readFileSync(
				join(project, ".ai-bdd", "report", "report.json"),
			);
			const digest = `sha256:${createHash("sha256").update(report).digest("hex")}`;
			const replay = result.record.checks.find(
				(check) => check.checkId === "acceptance-replay",
			);
			expect(replay?.evidence.report_digest).toBe(digest);
			expect(replay?.evidence.model_calls).toBe("0");
			const reparsed = parseStageGateRecord(
				serializeStageGateRecord(result.record),
			);
			expect(reparsed.gateId).toBe("release");
		},
		TIMEOUT,
	);

	it(
		"a stale plan fails the record with exit 4 and starts nothing after it",
		async () => {
			const project = resolve(REPO_ROOT, required("HOBO_AI_BDD_PROJECT"));
			const doc = join(project, required("HOBO_AI_BDD_STALE_DOC"));
			const original = readFileSync(doc);
			let result: RunStageGateResult;
			try {
				writeFileSync(
					doc,
					Buffer.concat([
						original,
						Buffer.from("\nThis sentence is not in the committed plan.\n"),
					]),
				);
				result = await runStageGate(defineReleaseGate(), { cwd: REPO_ROOT });
			} finally {
				writeFileSync(doc, original);
			}
			const statuses = result.record.checks.map((c) => [c.status, c.exitCode]);
			expect(statuses, recordText(result)).toEqual([
				["failed", 4],
				["skipped", -1],
				["skipped", -1],
			]);
			expect(result.record.status).toBe("failed");
		},
		TIMEOUT,
	);
});

describe.skipIf(SELECTED)("the release gate against a real ai-bdd", () => {
	it.skip("is selected by HOBO_AI_BDD_CMD (see the header of this file)", () => {
		// Not selected: the default lanes run the gate against the stand-in instead.
	});
});

/**
 * `fleet:vocabulary` (O1): each of the nine rules is shown a fixture tree that
 * breaks it, and must refuse exactly the files that break it while accepting
 * the allowlisted copies of the same violation beside them. A guard only ever
 * run against a clean tree has not been seen to refuse anything.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	type VocabularyFinding,
	matchesGlob,
	scanVocabulary,
} from "../check-fleet-vocabulary.mts";

const repoRoot = join(import.meta.dirname, "..", "..");
const fixtures = join(import.meta.dirname, "fixtures", "fleet-vocabulary");

function found(tree: string): Array<{ rule: number; path: string }> {
	return scanVocabulary(join(fixtures, tree))
		.map(({ rule, path }: VocabularyFinding) => ({ rule, path }))
		.sort((a, b) => a.rule - b.rule || a.path.localeCompare(b.path));
}

describe("fleet:vocabulary rules", () => {
	it("rule 1 refuses an import of, or a dependency on, @nats-io/* outside fleet-nats", () => {
		expect(found("rule-1")).toEqual([
			{ rule: 1, path: "packages/app/package.json" },
			{ rule: 1, path: "packages/app/src/bus.ts" },
			{ rule: 1, path: "packages/app/test/lazy.ts" },
		]);
	});

	it("rule 2 refuses an import of, or a dependency on, @number0/iroh outside fleet-p2p", () => {
		expect(found("rule-2")).toEqual([
			{ rule: 2, path: "packages/app/package.json" },
			{ rule: 2, path: "packages/app/src/p2p.ts" },
			{ rule: 2, path: "scripts/dial.mts" },
		]);
	});

	it("rule 3 refuses a function, const, class or object method with a fleet-owned name", () => {
		expect(found("rule-3")).toEqual([
			{ rule: 3, path: "packages/app/src/dpop.ts" },
			{ rule: 3, path: "packages/app/src/envelope.ts" },
			{ rule: 3, path: "packages/app/src/rank.ts" },
			{ rule: 3, path: "scripts/turns.mts" },
		]);
	});

	it("rule 4 refuses a proto message with a fleet record name outside fleet/data-models", () => {
		expect(found("rule-4")).toEqual([
			{ rule: 4, path: "packages/adapters/deep/data-models/deep.proto" },
			{ rule: 4, path: "packages/app/data-models/app.proto" },
		]);
		const details = scanVocabulary(join(fixtures, "rule-4")).map(
			(finding) => finding.detail,
		);
		expect(details.some((detail) => detail.includes("ClaimSet"))).toBe(false);
	});

	it("rule 5 refuses an identifier containing InternalMesh, and never scans the guard", () => {
		expect(found("rule-5")).toEqual([
			{ rule: 5, path: "packages/app/src/mesh.ts" },
			{ rule: 5, path: "packages/app/test/mesh.ts" },
		]);
	});

	it("rule 6 refuses a removed environment variable in code, workflows, devcontainer and deploy", () => {
		expect(found("rule-6")).toEqual([
			{ rule: 6, path: ".devcontainer/devcontainer.json" },
			{ rule: 6, path: ".github/workflows/ci.yml" },
			{ rule: 6, path: "deploy/fleet/host.env" },
			{ rule: 6, path: "packages/app/scripts/run.sh" },
			{ rule: 6, path: "packages/app/src/env.ts" },
			{ rule: 6, path: "packages/app/src/env.ts" },
		]);
		const details = scanVocabulary(join(fixtures, "rule-6")).map(
			(finding) => finding.detail,
		);
		expect(details.join("\n")).not.toContain("HOBO_CI_FLEET_STATEFUL");
		expect(details.join("\n")).not.toContain("HOBO_FLEET_HOME");
	});

	it("rule 7 refuses a path a lane deletes that still exists", () => {
		expect(found("rule-7")).toEqual([
			{ rule: 7, path: "packages/ci/src/mesh" },
			{ rule: 7, path: "scripts/ci/load-fleet-capacity.mts" },
		]);
	});

	it("rule 8 refuses @hobo/backend-fleet and @hobo/ci/mesh as specifiers, dependencies and workflow filters", () => {
		expect(found("rule-8")).toEqual([
			{ rule: 8, path: ".github/workflows/test.yml" },
			{ rule: 8, path: "packages/app/package.json" },
			{ rule: 8, path: "packages/app/src/routing.ts" },
			{ rule: 8, path: "packages/app/src/routing.ts" },
		]);
	});

	it("rule 9 refuses an exported Fleet/fleet/FLEET_ name outside the fleet packages and the allowlist", () => {
		const nine = scanVocabulary(join(fixtures, "rule-9"));
		expect(nine.map(({ rule, path, name }) => ({ rule, path, name }))).toEqual(
			expect.arrayContaining([
				{ rule: 9, path: "packages/app/src/fleet.ts", name: "fleetPlan" },
				{ rule: 9, path: "packages/app/src/fleet.ts", name: "FleetThing" },
				{ rule: 9, path: "packages/app/src/fleet.ts", name: "FleetMember" },
				{ rule: 9, path: "packages/app/src/fleet.ts", name: "FleetHolder" },
				{ rule: 9, path: "packages/app/src/fleet.ts", name: "FLEET_LIMIT" },
				{ rule: 9, path: "scripts/mode.mts", name: "fleetMode" },
			]),
		);
		expect(nine).toHaveLength(6);
	});

	it("accepts a tree with nothing to find", () => {
		expect(found("clean")).toEqual([]);
	});
});

describe("fleet:vocabulary command", () => {
	function cli(tree: string) {
		return spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				join(repoRoot, "scripts/check-fleet-vocabulary.mts"),
				`--root=${join(fixtures, tree)}`,
				"--json",
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
	}

	it("exits 1 and reports the findings as JSON when a rule refuses", () => {
		const result = cli("rule-5");
		expect(result.status).toBe(1);
		// SAFETY: the command's own --json report, parsed to read its findings.
		const report = JSON.parse(result.stdout) as {
			findings: VocabularyFinding[];
		};
		expect(report.findings.map((finding) => finding.rule)).toEqual([5, 5]);
		expect(result.stderr).toContain("rule 5");
	});

	it("exits 0 on a clean tree", () => {
		const result = cli("clean");
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});

describe("fleet:vocabulary allowlist", () => {
	it("starts with exactly the entries of the rules table", () => {
		// SAFETY: the allowlist's own JSON, compared field by field below.
		const allow = JSON.parse(
			readFileSync(
				join(repoRoot, "scripts/fleet-vocabulary-allow.json"),
				"utf8",
			),
		) as Array<{ rule: number; path: string; reason: string }>;
		expect(allow.map(({ rule, path }) => ({ rule, path }))).toEqual([
			{ rule: 1, path: "packages/fleet-nats/**" },
			{ rule: 2, path: "packages/fleet-p2p/**" },
			{ rule: 3, path: "packages/fleet/src/**" },
			{ rule: 4, path: "packages/fleet/data-models/**" },
			{ rule: 9, path: "packages/backend-routing/src/**" },
			{ rule: 9, path: "packages/data-postgres/src/fleet/**" },
			{
				rule: 9,
				path: "packages/ci-gh-actions/src/jit-runner-fleet-recovery.ts",
			},
			{ rule: 9, path: "packages/hobo/src/fleet-command.ts" },
			{ rule: 9, path: "scripts/ci/route-runner.mts" },
		]);
		for (const entry of allow) expect(entry.reason.length).toBeGreaterThan(0);
	});
});

describe("matchesGlob", () => {
	it("reads * as one path segment and ** as any depth", () => {
		expect(matchesGlob("packages/a/src/x.ts", "packages/*/src/**")).toBe(true);
		expect(matchesGlob("packages/a/b/src/x.ts", "packages/*/src/**")).toBe(
			false,
		);
		expect(matchesGlob("packages/a/b/c.proto", "packages/**/*.proto")).toBe(
			true,
		);
		expect(matchesGlob("packages/c.proto", "packages/**/*.proto")).toBe(true);
		expect(matchesGlob("packages/fleet-nats/x", "packages/fleet*/**")).toBe(
			true,
		);
		expect(matchesGlob("packages/fleet/x", "packages/fleet*/**")).toBe(true);
	});
});

/**
 * OptimizeXP runs linter CLI (`pnpm run optimizexp:lint-runs`).
 *
 * Verifies that every run claiming completion (pareto-equilibrium, plateau,
 * …) is backed by a committed minimal evidence bundle — scores chain with
 * matching sha256s and reviewable cited evidence. See lib/run-lint.mts for
 * the contract.
 *
 * Usage:
 *   node --import tsx .agents/skills/optimizexp/harness/lint-runs.mts --all
 *   node --import tsx .agents/skills/optimizexp/harness/lint-runs.mts --run <id>
 *   … [--json]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintAllRuns, lintRun, type RunLintResult } from "./lib/run-lint.mts";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);
const runsRoot = path.join(repoRoot, ".optimizexp", "runs");

function trackedFiles(): Set<string> {
	const r = spawnSync("git", ["ls-files", "-z", ".optimizexp/runs"], {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (r.status !== 0) return new Set();
	return new Set(r.stdout.split("\0").filter((f) => f.length > 0));
}

function main(): void {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	const runFlag = args.indexOf("--run");
	const tracked = trackedFiles();

	let results: RunLintResult[];
	if (runFlag >= 0 && args[runFlag + 1]) {
		results = [
			lintRun({
				runDir: path.join(runsRoot, args[runFlag + 1]!),
				repoRoot,
				trackedFiles: tracked,
			}),
		];
	} else {
		results = lintAllRuns({ runsRoot, repoRoot, trackedFiles: tracked });
	}

	const failed = results.filter((r) => r.status === "failed");
	if (json) {
		console.log(
			JSON.stringify({ ok: failed.length === 0, results }, null, 2),
		);
	} else {
		for (const r of results) {
			const badge =
				r.status === "verified"
					? "✓"
					: r.status === "superseded"
						? "≈"
						: r.status === "not-claiming"
							? "·"
							: "✗";
			console.log(
				`${badge} ${r.runId}${r.stopReason ? ` (${r.stopReason})` : ""} — ${r.status}`,
			);
			for (const p of r.problems) console.log(`    ${p}`);
		}
		const verified = results.filter((r) => r.status === "verified").length;
		console.log(
			`\nlint-runs: ${verified} verified · ${failed.length} failed · ${results.filter((r) => r.status === "superseded").length} superseded · ${results.filter((r) => r.status === "not-claiming").length} not claiming`,
		);
	}
	if (failed.length > 0) process.exit(1);
}

main();

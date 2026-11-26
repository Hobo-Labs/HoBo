import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintRun } from "../lib/run-lint.mts";

const repoRoot = mkdtempSync(path.join(tmpdir(), "optimizexp-runlint-"));
const runsRoot = path.join(repoRoot, ".optimizexp", "runs");

function makeRun(
	id: string,
	files: Record<string, string>,
): string {
	const dir = path.join(runsRoot, id);
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf8");
	}
	return dir;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// A run with no completion claim is left alone.
{
	const dir = makeRun("r-open", {
		"summary.md": "# run\nStop reason: `max-iterations`\n",
	});
	const r = lintRun({ runDir: dir, repoRoot });
	assert.equal(r.status, "not-claiming");
}

// A completion claim without committed numbers fails.
{
	const dir = makeRun("r-hollow", {
		"summary.md": "# run\nStop reason: `pareto-equilibrium`\n",
	});
	const r = lintRun({ runDir: dir, repoRoot });
	assert.equal(r.status, "failed");
	assert.ok(r.problems.some((p) => p.includes("baseline.json")));
	assert.ok(r.problems.some((p) => p.includes("scores.json")));
}

// A complete minimal bundle with a matching sha chain verifies.
{
	const baseline = JSON.stringify({ metric_total: 11, cells: [] });
	const final = JSON.stringify({ metric_total: 2, cells: [] });
	const dir = makeRun("r-good", {
		"summary.md": "# run\nStop reason: `pareto-equilibrium`\n",
		"baseline.json": baseline,
		"iterations/001/scores.json": final,
		"iterations/001/experiments/exp.json": JSON.stringify({
			after: {
				path: ".optimizexp/runs/r-good/iterations/001/scores.json",
				sha256: sha(final),
			},
		}),
	});
	const r = lintRun({ runDir: dir, repoRoot });
	assert.deepEqual(r.problems, []);
	assert.equal(r.status, "verified");
}

// A tampered scores file breaks the sha chain.
{
	const final = JSON.stringify({ metric_total: 2 });
	const dir = makeRun("r-tampered", {
		"summary.md": "# run\nStop reason: `plateau`\n",
		"baseline.json": JSON.stringify({ metric_total: 11 }),
		"iterations/001/scores.json": final,
		"iterations/001/experiments/exp.json": JSON.stringify({
			after: {
				path: ".optimizexp/runs/r-tampered/iterations/001/scores.json",
				sha256: sha("something else entirely"),
			},
		}),
	});
	const r = lintRun({ runDir: dir, repoRoot });
	assert.equal(r.status, "failed");
	assert.ok(r.problems.some((p) => p.includes("sha256 mismatch")));
}

// Baseline-copied final scores without justification fail.
{
	const same = JSON.stringify({ metric_total: 11, cells: [] });
	const dir = makeRun("r-copied", {
		"summary.md": "# run\nStop reason: `pareto-equilibrium`\n",
		"baseline.json": same,
		"iterations/001/scores.json": same,
	});
	const r = lintRun({ runDir: dir, repoRoot });
	assert.equal(r.status, "failed");
	assert.ok(r.problems.some((p) => p.includes("byte-identical")));
}

// Explicit supersession retires the claim without pretending it verified.
{
	const dir = makeRun("r-retired", {
		"summary.md": "# run\nStop reason: `pareto-equilibrium`\n",
		"superseded.json": JSON.stringify({
			supersededBy: "a-newer-run",
			reason: "artifacts were never committed; surface rebuilt",
			at: "2026-08-03T00:00:00Z",
		}),
	});
	const r = lintRun({ runDir: dir, repoRoot });
	assert.equal(r.status, "superseded");
}

// Tracked-files enforcement: on-disk-but-uncommitted numbers fail.
{
	const final = JSON.stringify({ metric_total: 2 });
	const dir = makeRun("r-untracked", {
		"summary.md": "# run\nStop reason: `pareto-equilibrium`\n",
		"baseline.json": JSON.stringify({ metric_total: 11 }),
		"iterations/001/scores.json": final,
	});
	const r = lintRun({
		runDir: dir,
		repoRoot,
		trackedFiles: new Set([".optimizexp/runs/r-untracked/summary.md"]),
	});
	assert.equal(r.status, "failed");
	assert.ok(r.problems.some((p) => p.includes("not committed")));
}

// A completion claim whose own evidenceChecks fail must not verify.
{
	const scores = JSON.stringify({
		metric_total: 2,
		evidenceChecks: [
			{
				evidence: ".optimizexp/runs/r-checks/evidence",
				firstOutputUnderMs: 50,
				note: "unrealistically strict budget — must fail",
			},
		],
	});
	const dir = makeRun("r-checks", {
		"summary.md": "# run\nStop reason: `pareto-equilibrium`\n",
		"baseline.json": JSON.stringify({ metric_total: 11 }),
		"iterations/001/scores.json": scores,
		"evidence/meta.json": JSON.stringify({
			exitCode: 0,
			primary: { file: "primary.txt" },
			timing: { durationMs: 900, timeToFirstOutputMs: 180 },
		}),
		"evidence/primary.txt": "recorded output",
	});
	const r = lintRun({ runDir: dir, repoRoot });
	assert.equal(r.status, "failed");
	assert.ok(r.problems.some((p) => p.includes("timeToFirstOutputMs 180")));
}

// The same claim verifies once the budget matches reality.
{
	const scores = JSON.stringify({
		metric_total: 2,
		evidenceChecks: [
			{
				evidence: ".optimizexp/runs/r-checks-ok/evidence",
				firstOutputUnderMs: 500,
				durationUnderMs: 5000,
			},
		],
	});
	const dir = makeRun("r-checks-ok", {
		"summary.md": "# run\nStop reason: `pareto-equilibrium`\n",
		"baseline.json": JSON.stringify({ metric_total: 11 }),
		"iterations/001/scores.json": scores,
		"evidence/meta.json": JSON.stringify({
			exitCode: 0,
			primary: { file: "primary.txt" },
			timing: { durationMs: 900, timeToFirstOutputMs: 180 },
		}),
		"evidence/primary.txt": "recorded output",
	});
	const r = lintRun({ runDir: dir, repoRoot });
	assert.deepEqual(r.problems, []);
	assert.equal(r.status, "verified");
}


// evidenceChecks bind even when the run makes no completion claim — declaring
// a budget and never checking it would defeat the point.
{
	const dir = makeRun("r-nonclaiming-checks", {
		"summary.md": "# run\nStop reason: `evidence-recertification`\n",
		"iterations/001/scores.json": JSON.stringify({
			evidenceChecks: [
				{
					evidence: ".optimizexp/runs/r-nonclaiming-checks/evidence",
					maxSilentGapUnderMs: 100,
				},
			],
		}),
		"evidence/meta.json": JSON.stringify({
			exitCode: 0,
			primary: { file: "primary.txt" },
			frameStats: { maxSilentGapMs: 900, totalOutputBytes: 10 },
		}),
		"evidence/primary.txt": "x",
	});
	const r = lintRun({ runDir: dir, repoRoot });
	assert.equal(r.status, "failed");
	assert.ok(r.problems.some((p) => p.includes("maxSilentGapMs 900")));
}

console.log("run-lint tests OK");

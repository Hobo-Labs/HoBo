/**
 * OptimizeXP drift-protection gate (`pnpm run optimizexp:check`).
 *
 * Hard-fail lanes (reusing the skill harness — import/spawn, never duplicate):
 *   a. Persona schema validation across the global tree (`.optimizexp/personas/`)
 *      and project-local trees (`packages/<pkg>/.optimizexp/personas/`) via the
 *      skill's `generate-persona.mts --mode validate` CLI (the harness modules
 *      execute `main()` on import, so they are spawned, not imported).
 *   b. Feature-quality/template lint over `.optimizexp/features/**` (plus
 *      project-local feature trees) via `checkGherkinQuality` from the skill's
 *      `lib/feature-quality.mts` — bans template-only "exercise the surface"
 *      Gherkin and missing `@persona:`/`@interface:` tags.
 *
 *   c. `validate-bus` over `.optimizexp/bus/entries/` via the review-loop CLI,
 *      including council bus/state cross-checks through the consensus helper.
 *      The 282 legacy entries that predated the current scorecard-evidence
 *      contract were archived to `.optimizexp/bus-archive/` (not scanned), so
 *      this lane is a hard fail. New runs are additionally gated per-run by
 *      `assert-complete` inside the review loop itself.
 *
 * Usage: node --import tsx scripts/check-optimizexp.mts
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkGherkinQuality,
	checkScenarioBinding,
} from "../.agents/skills/optimizexp/harness/lib/feature-quality.mts";
import { lintAllRuns } from "../.agents/skills/optimizexp/harness/lib/run-lint.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runHarness(script: string, args: string[]) {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", path.join(root, script), ...args],
		{ cwd: root, encoding: "utf8" },
	);
	if (result.error) throw result.error;
	return {
		status: result.status ?? 2,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

type PersonaReport = {
	ok: boolean;
	personas: { id: string; path: string; scope: string; problems: string[] }[];
};

/** Lane (a): persona schema validation. */
function checkPersonas(): string[] {
	const generatePersona =
		".agents/skills/optimizexp/harness/generate-persona.mts";
	const full = runHarness(generatePersona, ["--mode", "validate"]);
	let report: PersonaReport;
	try {
		// SAFETY: assertion to `.parse(full.stdout) as PersonaReport; }` is required at this boundary.
		report = JSON.parse(full.stdout) as PersonaReport;
	} catch {
		return [
			`persona validator did not emit JSON (exit ${full.status}): ${full.stderr.slice(0, 400)}`,
		];
	}
	if (full.status === 0 && report.ok) {
		console.log(
			`personas: OK (${report.personas.length} personas, all projects)`,
		);
		return [];
	}
	return report.personas
		.filter((p) => p.problems.length > 0)
		.map((p) => `${p.path}: ${p.problems.join("; ")}`);
}

/** Feature-folder roots mirroring `.optimizexp/cucumber.yaml` path globs. */
function featureDirs(): string[] {
	const roots = [
		".optimizexp/features",
		...["site", "packages", "examples", "src/draft/projects"].flatMap(
			(parent) => {
				const abs = path.join(root, parent);
				if (!existsSync(abs)) return [];
				return readdirSync(abs)
					.map((child) => path.join(parent, child, ".optimizexp/features"))
					.filter((rel) => existsSync(path.join(root, rel)));
			},
		),
	];
	const dirs: string[] = [];
	for (const rel of roots) {
		const abs = path.join(root, rel);
		for (const entry of readdirSync(abs)) {
			const dir = path.join(abs, entry);
			if (statSync(dir).isDirectory()) dirs.push(dir);
		}
	}
	return dirs;
}

/** Lane (b): feature-quality/template lint. */
function checkFeatureQuality(): string[] {
	const problems: string[] = [];
	const dirs = featureDirs();
	for (const dir of dirs) {
		const result = checkGherkinQuality(dir);
		for (const problem of result.problems) {
			problems.push(`${path.relative(root, dir)}: ${problem}`);
		}
	}
	if (problems.length === 0) {
		console.log(`feature-quality: OK (${dirs.length} feature folders)`);
	}
	return problems;
}

/** Lane (c): bus validation (hard fail). */
function checkBus(): string[] {
	const reviewLoop =
		".agents/skills/optimizexp/workflows/cross-agent/review-loop.mts";
	const result = runHarness(reviewLoop, ["--mode", "validate-bus"]);
	let report: {
		ok?: boolean;
		entries?: number;
		councilStates?: number;
		councilEntries?: number;
		problems?: string[];
	};
	try {
		// SAFETY: assertion to `.parse(result.stdout) as typeof report; }` is required at this boundary.
		report = JSON.parse(result.stdout) as typeof report;
	} catch {
		return [
			`bus: validate-bus did not emit JSON (exit ${result.status}): ${result.stderr.slice(0, 400)}`,
		];
	}
	if (result.status === 0 && report.ok) {
		console.log(
			`bus: OK (${report.entries ?? 0} entries; ${report.councilStates ?? 0} council states, ${report.councilEntries ?? 0} council entries)`,
		);
		return [];
	}
	return (report.problems ?? []).map((p) => `bus: ${p}`);
}

/** Project-local .optimizexp roots (packages/<pkg>/.optimizexp with config). */
function projectOptimizexpRoots(): string[] {
	const out: string[] = [];
	for (const parent of ["site", "packages", "examples"]) {
		const abs = path.join(root, parent);
		if (!existsSync(abs)) continue;
		for (const child of readdirSync(abs)) {
			const cfg = path.join(abs, child, ".optimizexp", "config.json");
			if (existsSync(cfg)) out.push(path.join(abs, child, ".optimizexp"));
		}
	}
	return out;
}

function readJson<T>(file: string): T | null {
	try {
		// SAFETY: assertion to `.parse(readFileSync(file, "utf8")) as T; }` is required at this boundary.
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

/**
 * Lane (d): scenario ↔ product binding. When a project's optimizexp config
 * declares `productBinary`, every feature folder must actually invoke it —
 * persona scenarios that only run repo scripts are filename decoration.
 */
function checkProductBinding(): string[] {
	const problems: string[] = [];
	let features = 0;
	for (const optRoot of projectOptimizexpRoots()) {
		const cfg = readJson<{ productBinary?: string }>(
			path.join(optRoot, "config.json"),
		);
		const productBinary = cfg?.productBinary;
		if (!productBinary) continue;
		const featuresRoot = path.join(optRoot, "features");
		if (!existsSync(featuresRoot)) continue;
		for (const entry of readdirSync(featuresRoot)) {
			const dir = path.join(featuresRoot, entry);
			if (!statSync(dir).isDirectory()) continue;
			features += 1;
			const result = checkScenarioBinding(dir, productBinary);
			for (const problem of result.problems) {
				problems.push(`${path.relative(root, dir)}: ${problem}`);
			}
		}
	}
	if (problems.length === 0) {
		console.log(`product-binding: OK (${features} feature folders)`);
	}
	return problems;
}

/**
 * Lane (e): experience-catalog persona coverage. Project-local personas at or
 * above the coverage priority (default ≤10, lower = more important) must own
 * at least one catalog row — 11 of 13 personas in one project previously
 * never reached the catalog, so their P0s could not fail assert-complete.
 */
function checkCatalogCoverage(): string[] {
	const problems: string[] = [];
	let personasChecked = 0;
	for (const optRoot of projectOptimizexpRoots()) {
		const cfg = readJson<{
			personas?: { coveragePriorityMax?: number };
		}>(path.join(optRoot, "config.json"));
		const catalogPath = path.join(optRoot, "experience-catalog.json");
		const personasDir = path.join(optRoot, "personas");
		if (!existsSync(catalogPath) || !existsSync(personasDir)) continue;
		const catalog = readJson<{
			experiences?: { personaId?: string }[];
		}>(catalogPath);
		const covered = new Set(
			(catalog?.experiences ?? [])
				.map((e) => e.personaId)
				.filter((p): p is string => p !== undefined),
		);
		const maxPriority = cfg?.personas?.coveragePriorityMax ?? 10;
		for (const file of readdirSync(personasDir).filter((f) =>
			f.endsWith(".md"),
		)) {
			const text = readFileSync(path.join(personasDir, file), "utf8");
			const id = text.match(/^id:\s*(\S+)/m)?.[1];
			const priority = Number(
				text.match(/^priority:\s*(\d+)/m)?.[1] ?? Number.NaN,
			);
			if (!id || Number.isNaN(priority) || priority > maxPriority) continue;
			personasChecked += 1;
			if (!covered.has(id)) {
				problems.push(
					`${path.relative(root, catalogPath)}: persona "${id}" (priority ${priority} ≤ ${maxPriority}) owns no experience-catalog row`,
				);
			}
		}
	}
	if (problems.length === 0) {
		console.log(`catalog-coverage: OK (${personasChecked} priority personas)`);
	}
	return problems;
}

/**
 * Lane (f): run-claim audit. Runs claiming completion (pareto-equilibrium,
 * plateau, …) must be backed by a committed minimal evidence bundle — scores
 * chain with matching sha256s and reviewable cited evidence. Also exposed as
 * `pnpm run optimizexp:lint-runs`.
 */
function checkRuns(): string[] {
	const tracked = new Set(
		(
			spawnSync("git", ["ls-files", "-z", ".optimizexp/runs"], {
				cwd: root,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
			}).stdout ?? ""
		)
			.split("\0")
			.filter((f) => f.length > 0),
	);
	const results = lintAllRuns({
		runsRoot: path.join(root, ".optimizexp", "runs"),
		repoRoot: root,
		trackedFiles: tracked,
	});
	const failed = results.filter((r) => r.status === "failed");
	if (failed.length === 0) {
		const verified = results.filter((r) => r.status === "verified").length;
		const superseded = results.filter((r) => r.status === "superseded").length;
		console.log(
			`run-claims: OK (${results.length} runs · ${verified} verified · ${superseded} superseded)`,
		);
		return [];
	}
	return failed.flatMap((r) => r.problems.map((p) => `runs/${r.runId}: ${p}`));
}

const problems = [
	...checkPersonas(),
	...checkFeatureQuality(),
	...checkBus(),
	...checkProductBinding(),
	...checkCatalogCoverage(),
	...checkRuns(),
];

if (problems.length > 0) {
	console.error(`\noptimizexp:check FAILED (${problems.length} problem(s)):`);
	for (const problem of problems.slice(0, 20)) {
		console.error(`  ✗ ${problem}`);
	}
	if (problems.length > 20) {
		console.error(`  … and ${problems.length - 20} more`);
	}
	process.exit(1);
}
console.log("\noptimizexp:check OK");

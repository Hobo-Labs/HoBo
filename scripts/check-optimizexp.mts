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
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

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
	...checkFeatureQuality(),
	...checkBus(),
	...checkProductBinding(),
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

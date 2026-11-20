#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { findFeature, listFeatures, relFromRepo, repoRoot } from "./lib/paths.mts";
import { resolvePersonaIds, listPersonaMetas } from "./lib/persona-resolve.mts";
import { projectSelectionProblem, resolveProjects } from "./lib/projects.mts";
import { normalizeCliOptions } from "./lib/cli-options.mts";
import { isPathIdentifier } from "./lib/slug.mts";
import { checkGherkinQuality } from "./lib/feature-quality.mts";

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		if (key === "--help" || key === "-h") args.mode = "help";
		else if (key === "--mode") args.mode = argv[++i] ?? "";
		else if (key === "--id") args.id = argv[++i] ?? "";
		else if (key === "--project" || key === "--projects") args.projects = argv[++i] ?? "";
		else if (key === "--all-projects") args.projects = "all";
		else if (key === "--experiences") args.experiences = argv[++i] ?? "";
		else if (key === "--personas") args.personas = argv[++i] ?? "";
		else if (key === "--generated-ids") args.generatedIds = argv[++i] ?? "";
		else if (key === "--max-personas") args.maxPersonas = argv[++i] ?? "";
	}
	return args;
}

function validate(args: Record<string, string>) {
	const root = repoRoot();
	const selection = resolveProjects(args.projects ?? "all", root);
	const locations = args.id
		? (() => {
				const hit = findFeature(args.id, root, { selection });
				return hit ? [hit] : [];
			})()
		: listFeatures(root, selection);
	const report: { id: string; scope?: string; path?: string; problems: string[] }[] =
		[];
	if (args.id && locations.length === 0) {
		report.push({
			id: args.id,
			problems: [
				"missing feature.json under global or project .optimizexp/features/",
			],
		});
	}
	for (const loc of locations) {
		const id = loc.id;
		const problems: string[] = [];
		const dir = loc.dir;
		const fj = path.join(dir, "feature.json");
		if (!existsSync(fj)) {
			problems.push("missing feature.json");
			report.push({
				id,
				scope: loc.scope.id,
				path: relFromRepo(dir, root),
				problems,
			});
			continue;
		}
		let meta: {
			schemaVersion?: number;
			id?: string;
			personas?: string[];
		};
		try {
			meta = JSON.parse(readFileSync(fj, "utf8")) as typeof meta;
		} catch {
			problems.push("feature.json invalid JSON");
			report.push({ id, problems });
			continue;
		}
		if (meta.schemaVersion !== 1 && meta.schemaVersion !== undefined) {
			problems.push("feature.json.schemaVersion should be 1");
		}
		if (meta.id && meta.id !== id) {
			problems.push(`feature.json.id ${meta.id} != folder ${id}`);
		}
		const featureFiles = readdirSync(dir).filter((f) => f.endsWith(".feature"));
		if (featureFiles.length === 0) {
			problems.push("no .feature files");
		}
		const personas = meta.personas || [];
		for (const p of personas) {
			const expected = `${id}-${p}.feature`;
			const alt = featureFiles.find(
				(f) => f.includes(p) || f === expected,
			);
			if (!alt) {
				problems.push(`missing per-persona file for persona ${p} (expected ${expected})`);
			}
		}
		for (const f of featureFiles) {
			const text = readFileSync(path.join(dir, f), "utf8");
			if (!/^\s*Feature:/m.test(text)) problems.push(`${f}: missing Feature:`);
			if (!/^\s*Scenario:/m.test(text)) problems.push(`${f}: missing Scenario:`);
			if (!/@persona:/.test(text)) problems.push(`${f}: missing @persona: tag`);
			if (!/@optimizexp/.test(text)) problems.push(`${f}: missing @optimizexp tag`);
		}
		const gq = checkGherkinQuality(dir);
		if (!gq.ok) {
			problems.push(...gq.problems.map((p) => `quality: ${p}`));
		}
		const stepsDir = path.join(dir, "steps");
		for (const req of [
			"bindings.steps.ts",
			"implementations.ts",
			"world.ts",
			"discovery.json",
		]) {
			if (!existsSync(path.join(stepsDir, req))) {
				problems.push(`missing steps/${req}`);
			}
		}
		const implementations = path.join(stepsDir, "implementations.ts");
		if (existsSync(implementations) && /(?:criticalPath|exerciseSurface|failurePath):\s*["']stub["']/.test(readFileSync(implementations, "utf8"))) {
			problems.push("feature contains unimplemented step bindings");
		}
		const testFile = path.join(dir, "test", `${id}.bindings.test.ts`);
		if (!existsSync(testFile)) {
			problems.push(`missing test/${id}.bindings.test.ts`);
		}
		const discPath = path.join(stepsDir, "discovery.json");
		if (existsSync(discPath)) {
			try {
				const disc = JSON.parse(readFileSync(discPath, "utf8")) as {
					bindings?: { command?: string; scriptName?: string }[];
				};
				const primary = disc.bindings?.[0];
				if (
					primary?.scriptName?.startsWith("eval:agent") ||
					(primary?.scriptName === "agent:check" &&
						!/agent.?check|staged/i.test(id))
				) {
					problems.push(
						`discovery primary looks like monorepo keyword trap: ${primary.scriptName} (prefer product bin)`,
					);
				}
			} catch {}
		}
		report.push({
			id,
			scope: loc.scope.id,
			path: relFromRepo(dir, root),
			problems,
		});
	}
	const ok = report.every((r) => r.problems.length === 0);
	console.log(JSON.stringify({ ok, features: report }, null, 2));
	if (!ok) process.exitCode = 1;
}

function resolveOnly(args: Record<string, string>) {
	const root = repoRoot();
	const selection = resolveProjects(args.projects ?? "all", root);
	const experiences = (args.experiences || "ux,dx,ax")
		.split(/[,\s]+/)
		.filter((e) => ["ux", "dx", "ax"].includes(e));
	const personasFlag = (args.personas || "").split(/[,\s]+/).filter(Boolean);
	const generatedIds = (args.generatedIds || "").split(/[,\s]+/).filter(Boolean);
	const r = resolvePersonaIds({
		personasFlag: personasFlag.length ? personasFlag : undefined,
		generatedIds: generatedIds.length ? generatedIds : undefined,
		experiences,
		maxPersonas: args.maxPersonas ? Number(args.maxPersonas) : undefined,
		root,
		selection,
	});
	console.log(
		JSON.stringify(
			{
				ok: true,
				experiences,
				personas: r.ids,
				reason: r.reason,
				available: listPersonaMetas(root, selection).map((m) => ({
					id: m.id,
					scope: m.scopeId,
					path: m.relPath,
				})),
			},
			null,
			2,
		),
	);
}

function main() {
	const input = normalizeCliOptions(process.argv.slice(2), {
		values: ["--mode", "--id", "--experiences", "--personas", "--generated-ids", "--max-personas", "--project", "--projects"],
		flags: ["--help", "-h", "--all-projects"],
		allowEmptyValues: ["--personas", "--generated-ids"],
	});
	if (input.error || input.positionals.length > 0) {
		console.error(input.error ?? "Unexpected positional argument");
		process.exit(2);
	}
	const args = parseArgs(input.argv);
	if (args.mode === "help") {
		console.log("Read-only modes: --mode validate, --mode resolve-personas. Implement requested behavior and executable tests directly.");
		return;
	}
	if (args.id && !isPathIdentifier(args.id)) {
		console.error(`Invalid feature id: ${args.id}`);
		process.exit(2);
	}
	const problem = projectSelectionProblem(resolveProjects(args.projects, repoRoot()));
	if (problem) {
		console.error(problem);
		process.exit(2);
	}
	if (args.mode === "validate") return validate(args);
	if (args.mode === "resolve-personas") return resolveOnly(args);
	console.error("Feature scaffolding and planning documents are prohibited. Implement the requested behavior and executable tests directly.");
	process.exitCode = 1;
}

main();

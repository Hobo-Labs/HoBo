#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib/paths.mts";
import { listPersonaMetas, parsePersonaModels } from "./lib/persona-resolve.mts";
import { projectSelectionProblem, resolveProjects } from "./lib/projects.mts";
import { normalizeCliOptions } from "./lib/cli-options.mts";
import { parseExperienceTypesFromYaml } from "./lib/experience-types.mts";

const REQUIRED_SECTIONS_V1 = [
	"Who I am",
	"Goals",
	"Constraints",
	"Accessibility & inclusion needs",
	"Success looks like",
	"Failure modes I hate",
	"Vocabulary I use",
	"Review instructions",
] as const;

const REQUIRED_SECTIONS_V2 = [
	...REQUIRED_SECTIONS_V1,
	"Market segment",
	"Demographic model",
	"Psychographic model",
	"Cognitive thresholds",
] as const;

function seedDigest(seed: string): string {
	return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function validatePersonaFile(filePath: string): string[] {
	const problems: string[] = [];
	if (!existsSync(filePath)) {
		return [`missing file: ${filePath}`];
	}
	const text = readFileSync(filePath, "utf8");
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
	if (!fm) {
		problems.push("missing YAML frontmatter");
		return problems;
	}
	const yaml = fm[1]!;
	const id = yaml.match(/^id:\s*(\S+)/m)?.[1];
	const schemaVersion = yaml.match(/^schemaVersion:\s*(\d+)/m)?.[1];
	const generated = yaml.match(/^generatedFromSeed:\s*(true|false)/m)?.[1];
	if (!id) problems.push("frontmatter.id required");
	if (schemaVersion !== "1" && schemaVersion !== "2") {
		problems.push("frontmatter.schemaVersion must be 1 or 2");
	}
	const exp = parseExperienceTypesFromYaml(yaml);
	problems.push(...exp.problems);
	if (schemaVersion === "2") {
		const segs = yaml.match(/^segmentIds:\s*\[([^\]]*)\]/m)?.[1];
		if (!segs || !segs.trim()) {
			problems.push("schemaVersion 2 requires frontmatter.segmentIds non-empty");
		}
	}
	if (id) {
		const base = path.basename(filePath, ".md");
		if (base !== id) {
			problems.push(`filename ${base}.md must match id ${id}`);
		}
	}
	const body = text.slice(fm[0].length);
	const sections =
		schemaVersion === "2" ? REQUIRED_SECTIONS_V2 : REQUIRED_SECTIONS_V1;
	for (const section of sections) {
		if (!new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(body)) {
			problems.push(`missing section: ## ${section}`);
		}
	}
	if (generated === "true") {
		if (!/^## Source seed\s*$/m.test(body)) {
			problems.push("generatedFromSeed true requires ## Source seed");
		}
		if (!/^seedDigest:\s*\S+/m.test(yaml)) {
			problems.push("generatedFromSeed true requires seedDigest");
		}
	}
	if (schemaVersion === "2") {
		const body = text.slice(fm[0].length);
		problems.push(...parsePersonaModels(body).problems);
		if (!/^marketPriority:\s*\d+\s*$/m.test(yaml)) problems.push("schemaVersion 2 requires marketPriority");
		if (!/^interfaces:\s*\[[^\]]+\]/m.test(yaml)) problems.push("schemaVersion 2 requires non-empty interfaces");
		if (generated === "true") {
			const seedBody = body.match(/^## Source seed[ \t]*\r?\n([\s\S]*)$/m)?.[1] ?? "";
			const source = seedBody.split(/^## /m)[0]?.trim() ?? "";
			const digest = yaml.match(/^seedDigest:\s*["']?([a-f0-9]{8,64})/mi)?.[1];
			if (!source) problems.push("generated persona requires non-empty source seed");
			else if (digest && seedDigest(source) !== digest) problems.push("seedDigest does not match Source seed");
		}
	}
	return problems;
}

function validate(args: Record<string, string>) {
	const root = repoRoot();
	const selection = resolveProjects(args.projects ?? "all", root);
	const metas = listPersonaMetas(root, selection);
	const filtered = args.id ? metas.filter((m) => m.id === args.id) : metas;
	const report: {
		id: string;
		path: string;
		scope: string;
		problems: string[];
	}[] = [];
	for (const m of filtered) {
		report.push({
			id: m.id,
			path: m.relPath,
			scope: m.scopeId,
			problems: validatePersonaFile(m.path),
		});
	}
	if (args.id && filtered.length === 0) {
		report.push({
			id: args.id,
			path: "",
			scope: "",
			problems: [
				`persona not found in global or project .optimizexp/personas/`,
			],
		});
	}
	const ok = report.every((r) => r.problems.length === 0);
	console.log(JSON.stringify({ ok, personas: report }, null, 2));
	if (!ok) process.exitCode = 1;
}

function main() {
	const input = normalizeCliOptions(process.argv.slice(2), {
		values: ["--mode", "--id", "--project", "--projects"],
		flags: ["--help", "-h", "--all-projects"],
	});
	if (input.error || input.positionals.length > 0) {
		console.error(input.error ?? "Unexpected positional argument");
		process.exit(2);
	}
	const argv = input.argv;
	const modeIndex = argv.indexOf("--mode");
	const mode = modeIndex >= 0 ? argv[modeIndex + 1] : undefined;
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("Read-only mode: --mode validate [--id ID] [--projects PROJECTS].");
		return;
	}
	const idIndex = argv.indexOf("--id");
	const projectsIndex = Math.max(argv.indexOf("--projects"), argv.indexOf("--project"));
	const projects = projectsIndex >= 0 ? argv[projectsIndex + 1] ?? "" : undefined;
	const problem = projectSelectionProblem(resolveProjects(projects, repoRoot()));
	if (problem) {
		console.error(problem);
		process.exit(2);
	}
	if (mode !== "validate") {
		console.error("Synthetic persona scaffolding is prohibited. Inspect real behavior and implement improvements directly.");
		process.exitCode = 1;
		return;
	}
	validate({
		...(idIndex >= 0 ? { id: argv[idIndex + 1] ?? "" } : {}),
		...(projects !== undefined ? { projects } : {}),
	});
}

main();

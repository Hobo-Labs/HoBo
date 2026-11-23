#!/usr/bin/env node
import process from "node:process";
import { repoRoot, relFromRepo } from "./lib/paths.mts";
import { listProjects, projectSelectionProblem, resolveProjects } from "./lib/projects.mts";
import { normalizeCliOptions } from "./lib/cli-options.mts";
import { optimizexpWriteProblem } from "./lib/write-containment.mts";
import { ensureGlobalConfig, ensureProjectConfig, loadConfigFile, resolveConfig, globalConfigPath, projectConfigPath } from "./lib/config.mts";
import { ensureGlobalGitignore, ensureProjectGitignore } from "./lib/gitignore.mts";

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	const projects: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		if (key === "--mode") args.mode = argv[++i] ?? "";
		else if (key === "--projects" || key === "--project") projects.push(argv[++i] ?? "");
		else if (key === "--all-projects") projects.push("all");
		else if (key === "--force") args.force = "1";
		else if (key === "--help" || key === "-h") args.help = "1";
		else if (key === "list-projects" || key === "--list-projects") args.mode = "list-projects";
		else if (key === "validate-config" || key === "--validate-config") args.mode = "validate-config";
		else if (key === "ensure-config" || key === "--ensure-config") args.mode = "ensure-config";
	}
	if (projects.length) args.projects = projects.join(",");
	return args;
}

function main() {
	const input = normalizeCliOptions(process.argv.slice(2), {
		values: ["--mode", "--project", "--projects"],
		flags: ["--help", "-h", "--force", "--all-projects", "--list-projects", "--validate-config", "--ensure-config"],
	});
	if (input.error) {
		console.error(input.error);
		process.exit(2);
	}
	const modeOptions = ["--mode", "--list-projects", "--validate-config", "--ensure-config"];
	if (
		input.positionals.length > 1 ||
		input.positionals.some((value) => !["list-projects", "validate-config", "ensure-config"].includes(value)) ||
		(input.positionals.length > 0 && modeOptions.some((option) => input.argv.includes(option)))
	) {
		console.error("Expected at most one positional init mode");
		process.exit(2);
	}
	const args = parseArgs(input.argv);
	if (args.help === "1") {
		console.log("Modes: list-projects, validate-config, ensure-config. Implement and verify requested improvements directly.");
		return;
	}
	const root = repoRoot();
	const selection = resolveProjects(args.projects, root);
	const problem = projectSelectionProblem(selection);
	if (problem) {
		console.error(problem);
		process.exit(2);
	}
	if (args.mode === "ensure-config") {
		const writeProblem = optimizexpWriteProblem(root, ["", ...selection.projects.map((project) => project.path)]);
		if (writeProblem) {
			console.error(writeProblem);
			process.exit(2);
		}
	}
	if (args.mode === "list-projects") {
		const projects = listProjects(root);
		console.log(
			JSON.stringify(
				{
					ok: true,
					default: "all",
					count: projects.length,
					projects: projects.map((p) => ({
						id: p.id,
						path: p.path || ".",
						kind: p.kind,
						label: p.label,
						packageName: p.packageName ?? null,
						configPath:
							p.kind === "root" || !p.path
								? relFromRepo(globalConfigPath(root), root)
								: relFromRepo(projectConfigPath(p, root), root),
					})),
				},
				null,
				2,
			),
		);
		return;
	}

	if (args.mode === "validate-config") {
		const selection = resolveProjects(args.projects ?? "all", root);
		const files: { path: string; problems: string[]; exists: boolean }[] = [];
		const g = loadConfigFile(globalConfigPath(root));
		files.push({
			path: relFromRepo(g.path, root),
			problems: g.problems,
			exists: g.exists,
		});
		for (const p of selection.projects) {
			if (p.kind === "root" || !p.path) continue;
			const c = loadConfigFile(projectConfigPath(p, root));
			files.push({
				path: relFromRepo(c.path, root),
				problems: c.problems,
				exists: c.exists,
			});
		}
		const { resolved, problems: mergeProblems } = resolveConfig({
			root,
			focusProject:
				!selection.allProjects && selection.projects.length === 1
					? selection.projects[0]!
					: null,
		});
		const ok =
			files.every((f) => f.problems.length === 0) && mergeProblems.length === 0;
		console.log(
			JSON.stringify(
				{
					ok,
					files,
					mergeProblems,
					resolved: {
						kind: resolved.kind,
						projectId: resolved.projectId,
						defaults: resolved.defaults,
						sources: resolved.sources,
					},
				},
				null,
				2,
			),
		);
		if (!ok) process.exitCode = 1;
		return;
	}

	if (args.mode === "ensure-config") {
		const selection = resolveProjects(args.projects ?? "all", root);
		const created: string[] = [];
		const gitignores: {
			path: string;
			written: boolean;
			reason: string;
		}[] = [];
		const g = ensureGlobalConfig(root, { force: args.force === "1" });
		if (g.created) created.push(relFromRepo(g.path, root));
		const { resolved: globalResolved } = resolveConfig({ root });
		const gGi = ensureGlobalGitignore(globalResolved.gitignore, root);
		gitignores.push({
			path: relFromRepo(gGi.path, root),
			written: gGi.written,
			reason: gGi.reason,
		});
		for (const p of selection.projects) {
			if (p.kind === "root" || !p.path) continue;
			const experiences =
				p.kind === "site" || p.id === "site"
					? (["ux"] as const)
					: p.kind === "package" && (p.id === "cli" || p.id === "hobo")
						? (["dx", "ax"] as const)
						: undefined;
			const driver =
				p.kind === "site" || p.id === "site" ? ("web" as const) : undefined;
			const r = ensureProjectConfig(p, root, {
				force: args.force === "1",
				experiences: experiences ? [...experiences] : undefined,
				driver,
			});
			if (r.created) created.push(relFromRepo(r.path, root));
			const { resolved: projResolved } = resolveConfig({
				root,
				focusProject: p,
			});
			const pGi = ensureProjectGitignore(p, projResolved.gitignore, root);
			gitignores.push({
				path: relFromRepo(pGi.path, root),
				written: pGi.written,
				reason: pGi.reason,
			});
		}
		console.log(
			JSON.stringify(
				{
					ok: true,
					created,
					gitignores,
					note: "Existing configs left untouched unless --force; gitignore managed blocks refreshed from config",
				},
				null,
				2,
			),
		);
		return;
	}

	console.error("Synthetic experience scaffolding is prohibited. Implement and verify the requested improvements directly.");
	process.exitCode = 1;
}

main();

#!/usr/bin/env node
/**
 * Explore a product project → surface-map.json (+ optional experience-catalog).
 *
 * node --import tsx .agents/skills/optimizexp/harness/explore-app.mts --project hobo
 * node --import tsx .agents/skills/optimizexp/harness/explore-app.mts --mode validate --project hobo
 * node --import tsx .agents/skills/optimizexp/harness/explore-app.mts --mode catalog --project hobo --personas developer
 */
import process from "node:process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeCliOptions } from "./lib/cli-options.mts";
import { optimizexpWriteProblem } from "./lib/write-containment.mts";
import { listProjects, resolveProjects } from "./lib/projects.mts";
import { repoRoot } from "./lib/paths.mts";
import {
	buildSurfaceMap,
	assessPackageCli,
	readSurfaceMap,
	validateSurfaceMap,
	validateCurrentSurface,
	writeSurfaceMap,
} from "./lib/surface-map.mts";
import {
	buildExperienceCatalog,
	validateCatalogCoverage,
	writeExperienceCatalog,
} from "./lib/experience-catalog.mts";

function parseArgs(argv: string[]) {
	const out: Record<string, string> = { mode: "explore" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--help" || a === "-h") out.mode = "help";
		else if (a === "--mode") out.mode = argv[++i] ?? "explore";
		else if (a === "--project" || a === "--projects") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-") || !value.split(/[,\s]+/).some(Boolean)) out.projectError = "--project requires a project id or path";
			else {
				i++;
				out.projects = out.projects ? `${out.projects},${value}` : value;
			}
		} else if (a === "--all-projects") out.projects = out.projects ? `${out.projects},all` : "all";
		else if (a === "--personas") out.personas = argv[++i] ?? "";
		else if (a === "--skip-probes") out.skipProbes = "1";
		else if (a === "--probe-bin") out.probeBin = "1";
		else if (a.startsWith("--confirm-surface-current=")) out.confirmedSurfaces = [out.confirmedSurfaces, a.slice("--confirm-surface-current=".length)].filter(Boolean).join(",");
		else if (a === "--with-catalog") out.withCatalog = "1";
	}
	return out;
}

function help() {
	console.log(`optimizexp explore-app

  --mode explore          Build surface-map.json (default)
  --mode validate         Validate existing surface-map
  --mode catalog          Build experience-catalog from map + personas
  --project <id>          Project id (e.g. hobo, site, cli)
  --personas a,b          Limit catalog personas
  --skip-probes           No live CLI probes (tests)
  --probe-bin             Run the primary binary with --help (trusted code; inherits environment and may change state)
  --confirm-surface-current=<project>:<map-sha256>  Assert saved observation still matches current imports, config, and environment (repeatable)
  --with-catalog          Compatibility flag; explore always writes the experience catalog

Feeds critical-path feature generation (see references/feature-quality.md).
`);
}

function packageFallback(token: string, root: string): (ReturnType<typeof listProjects>)[number] | null {
	const rel = token.startsWith("packages/") ? token : `packages/${token}`;
	if (!/^packages\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(rel)) return null;
	try {
		const repo = realpathSync(root);
		const packages = realpathSync(path.join(root, "packages"));
		const actual = realpathSync(path.join(root, rel));
		const under = (base: string, target: string) => {
			const relative = path.relative(base, target);
			return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		};
		if (!under(repo, packages) || !under(packages, actual) || !statSync(actual).isDirectory()) return null;
		if (assessPackageCli(actual, root).status === "unverified") return null;
		return { id: token, path: rel, kind: "package", label: token };
	} catch {
		return null;
	}
}

function validTargetDirectory(root: string, projectPath: string): boolean {
	try {
		const repo = realpathSync(root);
		const actual = realpathSync(path.resolve(root, projectPath || "."));
		const relative = path.relative(repo, actual);
		return statSync(actual).isDirectory() && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	} catch {
		return false;
	}
}

function main() {
	const input = normalizeCliOptions(process.argv.slice(2), {
		values: ["--mode", "--project", "--projects", "--personas"],
		flags: ["--help", "-h", "--all-projects", "--skip-probes", "--probe-bin", "--with-catalog"],
		inlineValues: ["--confirm-surface-current"],
	});
	if (input.error) {
		console.error(input.error);
		process.exit(2);
	}
	if (input.positionals.length) {
		console.error(`Unexpected positional argument: ${input.positionals[0]}`);
		process.exit(2);
	}
	const args = parseArgs(input.argv);
	if (args.mode === "help") {
		help();
		return;
	}
	if (!["explore", "validate", "catalog"].includes(args.mode ?? "")) {
		console.error(`Unknown mode: ${args.mode}`);
		process.exit(2);
	}
	if (args.projectError) {
		console.error(args.projectError);
		process.exit(2);
	}
	const tokens = (args.projects || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
	const allAliases = new Set(["all", "all-projects", "*", "every", "everything"]);
	if (tokens.some((token) => allAliases.has(token)) && tokens.some((token) => !allAliases.has(token))) {
		console.error("The all-projects selector cannot be combined with project ids or paths.");
		process.exit(2);
	}
	const root = repoRoot();
	const selection = resolveProjects(args.projects || "all", root);
	const all = listProjects(root);
	const targets = selection.allProjects
		? all.filter((p) => p.id !== "root" || all.length === 1)
		: [...selection.projects];

	for (const token of selection.unknown) {
		const fallback = packageFallback(token, root);
		if (!fallback) {
			console.error(`Unknown or invalid project: ${token}`);
			process.exit(2);
		}
		if (!targets.some((project) => project.path === fallback.path)) targets.push(fallback);
	}
	if (targets.length === 0) {
		console.error("No projects resolved. Pass --project <id> (list them: init.mts --mode list-projects)");
		process.exit(2);
	}
	for (const project of targets) {
		if (!validTargetDirectory(root, project.path)) {
			console.error(`Invalid project directory: ${project.id}`);
			process.exit(2);
		}
	}
	if (args.mode !== "validate") {
		const problem = optimizexpWriteProblem(root, targets.map((project) => project.path));
		if (problem) {
			console.error(problem);
			process.exit(2);
		}
	}

	const confirmedSurfaces = (args.confirmedSurfaces || "").split(",").filter(Boolean);
	const personaIds = (args.personas || "")
		.split(/[,\s]+/)
		.filter(Boolean);

	for (const project of targets) {
		if (args.mode === "validate") {
			const map = readSurfaceMap(project, root);
			if (!map) {
				console.log(
					JSON.stringify(
						{ ok: false, projectId: project.id, problems: ["surface-map missing"] },
						null,
						2,
					),
				);
				process.exitCode = 1;
				continue;
			}
			const problems = [...validateSurfaceMap(map), ...validateCurrentSurface(map, root, { confirmedSurfaces })];
			const current = assessPackageCli(path.join(root, project.path || "."), root);
			if (JSON.stringify(map.cliAssessment) !== JSON.stringify(current)) {
				problems.push("package-bin assessment is stale; re-explore the current manifest");
			}
			console.log(
				JSON.stringify(
					{ ok: problems.length === 0, projectId: project.id, problems, mapPath: "surface-map.json", cliAssessment: map.cliAssessment, coverageScope: "package.json bin only; other surfaces are not assessed" },
					null,
					2,
				),
			);
			if (problems.length) process.exitCode = 1;
			continue;
		}

		if (args.mode === "catalog") {
			const map = readSurfaceMap(project, root);
			const catalog = buildExperienceCatalog({
				project,
				root,
				surfaceMap: map,
				personaIds: personaIds.length ? personaIds : undefined,
			});
			const current = assessPackageCli(path.join(root, project.path || "."), root);
			if (map && JSON.stringify(map.cliAssessment) !== JSON.stringify(current)) {
				catalog.surfaceProblems?.push("package-bin assessment is stale; re-explore the current manifest");
			}
			const pathOut = writeExperienceCatalog(catalog, project, root);
			const cov = validateCatalogCoverage(
				catalog,
				personaIds.length
					? personaIds
					: [...new Set(catalog.experiences.map((e) => e.personaId))],
				map ?? undefined,
				{ root, confirmedSurfaces },
			);
			console.log(
				JSON.stringify(
					{
						ok: cov.length === 0,
						projectId: project.id,
						path: pathOut,
						experienceCount: catalog.experiences.length,
						cliAssessment: catalog.cliAssessment,
						coverageScope: "package.json bin only; other surfaces are not assessed",
						coverageProblems: cov,
					},
					null,
					2,
				),
			);
			if (cov.length) process.exitCode = 1;
			continue;
		}

		// explore
		const map = buildSurfaceMap({
			project,
			root,
			probeBinary: args.probeBin === "1",
			skipProbes: args.skipProbes === "1",
		});
		const pathOut = writeSurfaceMap(map, project, root);
		const problems = validateSurfaceMap(map);
		let catalogPath: string | undefined;
		let catalogProblems: string[] = [];
		if (args.withCatalog === "1" || args.mode === "explore") {
			// always build catalog after explore for critical path
			const catalog = buildExperienceCatalog({
				project,
				root,
				surfaceMap: map,
				personaIds: personaIds.length ? personaIds : undefined,
			});
			catalogPath = writeExperienceCatalog(catalog, project, root);
			catalogProblems = validateCatalogCoverage(
				catalog,
				personaIds.length
					? personaIds
					: [...new Set(catalog.experiences.map((e) => e.personaId))],
				map,
				{ root, confirmedSurfaces, freshProbe: args.probeBin === "1" && args.skipProbes !== "1" },
			);
		}
		console.log(
			JSON.stringify(
				{
					ok: problems.length === 0 && catalogProblems.length === 0,
					projectId: project.id,
					surfaceMap: pathOut,
					productName: map.productName,
					binaries: map.binaries.map((b) => b.name),
					cliAssessment: map.cliAssessment,
					coverageScope: "package.json bin only; other surfaces are not assessed",
					defaultEntry: map.defaultEntry,
					commandCount: map.commands.length,
					requiredJourneys: map.requiredJourneys,
					interactive: map.defaultEntry?.interactive ?? null,
					problems,
					catalogPath,
					catalogProblems,
				},
				null,
				2,
			),
		);
		if (problems.length || catalogProblems.length) process.exitCode = 1;
	}
}

main();

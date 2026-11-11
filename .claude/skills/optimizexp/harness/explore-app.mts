#!/usr/bin/env node
/**
 * Explore a product project → surface-map.json (+ optional experience-catalog).
 *
 * node --import tsx .agents/skills/optimizexp/harness/explore-app.mts --project hobo
 * node --import tsx .agents/skills/optimizexp/harness/explore-app.mts --mode validate --project hobo
 * node --import tsx .agents/skills/optimizexp/harness/explore-app.mts --mode catalog --project hobo --personas developer
 */
import process from "node:process";
import { listProjects, resolveProjects } from "./lib/projects.mts";
import { repoRoot } from "./lib/paths.mts";
import {
	buildSurfaceMap,
	readSurfaceMap,
	validateSurfaceMap,
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
			out.projects = out.projects
				? `${out.projects},${argv[++i] ?? ""}`
				: (argv[++i] ?? "");
		} else if (a === "--personas") out.personas = argv[++i] ?? "";
		else if (a === "--skip-probes") out.skipProbes = "1";
		else if (a === "--with-catalog") out.withCatalog = "1";
	}
	return out;
}

function help() {
	console.log(`optimizexp explore-app

  --mode explore          Build surface-map.json (default)
  --mode validate         Validate existing surface-map
  --mode catalog          Build experience-catalog from map + personas
  --project <id>          Project id (e.g. code, site, cli)
  --personas a,b          Limit catalog personas
  --skip-probes           No live CLI probes (tests)
  --with-catalog          Also write experience-catalog after explore

Feeds critical-path feature generation (see references/feature-quality.md).
`);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === "help") {
		help();
		return;
	}
	const root = repoRoot();
	const selection = resolveProjects(args.projects || "all", root);
	const all = listProjects(root);
	let targets = selection.allProjects
		? all.filter((p) => p.id !== "root" || all.length === 1)
		: [...selection.projects];

	if (targets.length === 0) {
		// fall back to explicit id path packages/<id>
		const id = (args.projects || "").split(",")[0]?.trim();
		if (id) {
			const hit = all.find((p) => p.id === id);
			if (hit) targets = [hit];
			else {
				targets = [
					{
						id,
						path: id.startsWith("packages/") ? id : `packages/${id}`,
						kind: "package",
						label: id,
					} as (typeof all)[0],
				];
			}
		}
	}

	if (targets.length === 0) {
		console.error(
			"No projects resolved. Pass --project <id> (list them: init.mts --mode list-projects)",
		);
		process.exit(2);
	}

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
			const problems = validateSurfaceMap(map);
			console.log(
				JSON.stringify(
					{ ok: problems.length === 0, projectId: project.id, problems, mapPath: "surface-map.json" },
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
			const pathOut = writeExperienceCatalog(catalog, project, root);
			const cov = validateCatalogCoverage(
				catalog,
				personaIds.length
					? personaIds
					: [...new Set(catalog.experiences.map((e) => e.personaId))],
			);
			console.log(
				JSON.stringify(
					{
						ok: cov.length === 0,
						projectId: project.id,
						path: pathOut,
						experienceCount: catalog.experiences.length,
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
					defaultEntry: map.defaultEntry,
					commandCount: map.commands.length,
					requiredJourneys: map.requiredJourneys,
					interactive: map.defaultEntry?.interactive ?? false,
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

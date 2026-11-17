/**
 * Build persona × experience catalog from surface-map + persona files.
 * Critical input to high-quality feature generation.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mts";
import type { ProjectRef } from "./projects.mts";
import { readSurfaceMap, surfaceMapDigest, validateSurfaceMap, validateCurrentSurface, type CliAssessment, type SurfaceMap } from "./surface-map.mts";
import { listPersonaMetas } from "./persona-resolve.mts";

export type CatalogPriority = "P0" | "P1" | "P2";

export type ExperienceRow = {
	experienceId: string;
	personaId: string;
	intent: string;
	entryCommand: string;
	driver: "cli" | "tui" | "web" | "native";
	observableSuccess: string;
	observableFailure: string;
	confusionRisks: string[];
	priority: CatalogPriority;
	featureId: string;
	source: string[];
};

export type ExperienceCatalog = {
	schemaVersion: 1;
	projectId: string;
	builtAt: string;
	cliAssessment?: CliAssessment;
	surfaceMapDigest?: string;
	surfaceProblems?: string[];
	unverifiedGoals?: { personaId: string; goal: string; reason: string }[];
	experiences: ExperienceRow[];
};

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 48);
}

function productSlug(map: SurfaceMap): string {
	return slug(map.productName || map.projectId);
}

function wantsCostGoal(personaId: string, body: string): boolean {
	return /\b(?:finops|cost[- ]controller|cost information|cost estimate|estimated? costs?|budget information)\b/i.test(`${personaId} ${body}`);
}

/** Help must identify a cost surface; a generic `plan` verb alone is insufficient. */
function costCommand(map: SurfaceMap): SurfaceMap["commands"][number] | undefined {
	return map.commands.find((command) => {
		if (command.id !== "cost" && command.id !== "plan") return false;
		const summary = command.summary ?? "";
		if (/\b(?:no|not|never|without|unavailable|unknown|unsupported)\b/i.test(summary)) return false;
		return command.id === "cost" || /\b(?:costs?|pricing|prices?|budget|spend|charges?)\b/i.test(summary);
	});
}

/**
 * Build catalog: mandatory P0 journeys + persona-linked surfaces.
 */
export function buildExperienceCatalog(input: {
	project: ProjectRef;
	personaIds?: string[];
	root?: string;
	surfaceMap?: SurfaceMap | null;
}): ExperienceCatalog {
	const root = input.root ?? repoRoot();
	const map =
		input.surfaceMap ??
		readSurfaceMap(input.project, root) ??
		({
			schemaVersion: 1,
			projectId: input.project.id,
			scannedAt: new Date().toISOString(),
			productName: input.project.id,
			packageDir: input.project.path || ".",
			binaries: [],
			defaultEntry: null,
			nonInteractiveHelp: null,
			commands: [],
			interactiveSurfaces: [],
			requiredJourneys: [],
			probes: [],
		} satisfies SurfaceMap);

	const metas = listPersonaMetas(root);
	const personaFilter = input.personaIds?.length
		? new Set(input.personaIds)
		: null;
	const personas = metas.filter(
		(m) => !personaFilter || personaFilter.has(m.id),
	);
	// If no personas in global list for project, use filter ids alone
	const personaIds =
		personas.length > 0
			? personas.map((p) => p.id)
			: input.personaIds?.length
				? input.personaIds
				: ["developer"];

	const prod = productSlug(map);
	const bin = map.defaultEntry?.command ?? map.binaries[0]?.name ?? null;
	const rows: ExperienceRow[] = [];
	const unverifiedGoals: NonNullable<ExperienceCatalog["unverifiedGoals"]> = [];
	const seen = new Set<string>();

	const add = (row: ExperienceRow) => {
		const k = `${row.experienceId}::${row.personaId}`;
		if (seen.has(k)) return;
		seen.add(k);
		rows.push(row);
	};

	for (const personaId of personaIds) {
		// P0: default entry
		if (bin) {
			const interactive = Boolean(map.defaultEntry?.interactive);
			add({
				experienceId: interactive ? "cold-start-tty-chat" : "cold-start-cli",
				personaId,
				intent: interactive
					? "Cold-start the product TTY/chat and recognize it is not a stock third-party agent UI"
					: "Cold-start the product CLI default path and get clear status",
				entryCommand: bin,
				driver: interactive ? "tui" : "cli",
				observableSuccess: interactive
					? "The documented entry and help path are visible"
					: "Helpful default or usage without silent hang",
				observableFailure: "Hang, empty chrome, or wrong-product branding only",
				confusionRisks: ["wrong entry point", "unclear default behavior"],
				priority: "P0",
				featureId: `${prod}-default-entry`,
				source: ["surface-map.defaultEntry", "mandatory-p0"],
			});
			if (interactive) {
				add({
					experienceId: "in-session-discoverability",
					personaId,
					intent: "From inside the interactive session, find product surfaces without leaving",
					entryCommand: `${bin}  # use the documented in-session help`,
					driver: "tui",
					observableSuccess: "The documented in-session help path is visible",
					observableFailure: "Only third-party defaults; no product map",
					confusionRisks: ["undiscoverable in-session help"],
					priority: "P0",
					featureId: `${prod}-default-entry`,
					source: ["surface-map.interactiveSurfaces", "mandatory-p0"],
				});
			}
		}

		// Only a discovered help entry is an executable journey.
		if (map.nonInteractiveHelp) add({
			experienceId: "help-discoverability",
			personaId,
			intent: "List verbs and next steps without tribal knowledge",
			entryCommand: map.nonInteractiveHelp.command,
			driver: "cli",
			observableSuccess: "Verb list + First run / examples",
			observableFailure: "Empty help or wrong product help",
			confusionRisks: ["help dumps unrelated monorepo tooling"],
			priority: "P0",
			featureId: `${prod}-help-discoverability`,
			source: ["surface-map.nonInteractiveHelp", "mandatory-p0"],
		});

		// P0: failure path (generic bad verb)
		if (bin) add({
			experienceId: "failure-actionable",
			personaId,
			intent: "Mistype or unknown verb yields actionable remediation",
			entryCommand: `${bin} not-a-real-verb-zz`,
			driver: "cli",
			observableSuccess: "Non-zero exit + suggested next command",
			observableFailure: "Silent success or stack dump only",
			confusionRisks: ["typo becomes dispatch"],
			priority: "P0",
			featureId: `${prod}-failure-actionable`,
			source: ["mandatory-p0"],
		});

		// Persona-linked inventory commands from map
		const personaPath = findPersonaPath(root, personaId);
		const personaBody = personaPath ? readFileSync(personaPath, "utf8") : "";
		if (wantsCostGoal(personaId, personaBody) &&
			!costCommand(map)) {
			unverifiedGoals.push({ personaId, goal: "inspect cost information", reason: "no observed cost command or cost-specific plan help in the package surface" });
		}
		const wants = inferPersonaSurfaces(personaId, personaBody, map);
		for (const w of wants) {
			add({
				experienceId: w.experienceId,
				personaId,
				intent: w.intent,
				entryCommand: w.entryCommand,
				driver: w.driver,
				observableSuccess: w.observableSuccess,
				observableFailure: w.observableFailure,
				confusionRisks: w.confusionRisks,
				priority: w.priority,
				featureId: w.featureId,
				source: w.source,
			});
		}
	}

	return {
		schemaVersion: 1,
		projectId: map.projectId,
		builtAt: new Date().toISOString(),
		cliAssessment: map.cliAssessment ?? {
			status: "unverified",
			scope: "package.json bin",
			evidence: "surface map has no package-bin assessment",
		},
		surfaceMapDigest: surfaceMapDigest(map),
		surfaceProblems: validateSurfaceMap(map),
		unverifiedGoals,
		experiences: rows,
	};
}

function findPersonaPath(root: string, id: string): string | null {
	const candidates = [
		path.join(root, ".optimizexp/personas", `${id}.md`),
		// project personas common locations
		...safeList(path.join(root, "packages"))
			.map((p) => path.join(root, "packages", p, ".optimizexp/personas", `${id}.md`))
			.filter((p) => existsSync(p)),
	];
	// also scan packages/*/ .optimizexp
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	// walk packages
	const packagesDir = path.join(root, "packages");
	if (existsSync(packagesDir)) {
		for (const name of readdirSync(packagesDir)) {
			const p = path.join(packagesDir, name, ".optimizexp/personas", `${id}.md`);
			if (existsSync(p)) return p;
		}
	}
	return null;
}

function safeList(dir: string): string[] {
	try {
		return existsSync(dir) ? readdirSync(dir) : [];
	} catch {
		return [];
	}
}

function inferPersonaSurfaces(
	personaId: string,
	body: string,
	map: SurfaceMap,
): Omit<ExperienceRow, "personaId">[] {
	const prod = productSlug(map);
	const bin = map.defaultEntry?.command ?? map.binaries[0]?.name ?? null;
	const out: Omit<ExperienceRow, "personaId">[] = [];
	if (!bin) return out;

	const pushVerb = (
		verb: string,
		experienceId: string,
		intent: string,
		priority: CatalogPriority = "P0",
		observableSuccess = `Command ${verb} returns documented output`,
		observableFailure = "Missing verb or opaque error",
	) => {
		const c = map.commands.find((command) => command.id === verb);
		if (!c) return;
		out.push({
			experienceId,
			intent,
			entryCommand: `${bin} ${c.argv.join(" ")}`,
			driver: "cli",
			observableSuccess,
			observableFailure,
			confusionRisks: [],
			priority,
			featureId: `${prod}-${verb}`,
			source: ["persona-goals", `surface-map.commands.${verb}`],
		});
	};

	if (/protocol-native|coding-agent|agent-native|unattended/i.test(personaId + body)) {
		pushVerb("agent", "agent-native-inventory", "Audit human-free auth + MCP/ACP readiness");
		pushVerb("auth", "agent-human-free-auth", "Login without browser device-code as agent");
	}
	if (wantsCostGoal(personaId, body)) {
		const command = costCommand(map);
		if (command?.id === "cost") {
			pushVerb("cost", "cost-zero-path", "Inspect cost and budget information", "P0", "The output reports cost or budget information", "Cost or budget information is missing or unavailable, or the command errors");
		} else if (command?.id === "plan") {
			pushVerb("plan", "plan-cost", "Inspect the deployment plan for cost information", "P0", "The output reports cost or budget information", "Cost or budget information is missing or unavailable, or the command errors");
		}
	}
	if (/vim|neovim|editor-vim|cli-native/i.test(personaId + body)) {
		pushVerb("edit", "edit-workflow", "Inspect the documented edit workflow");
	}
	if (/config|setup|stack|hermetic|nix|devenv/i.test(personaId + body)) {
		pushVerb("config", "config-setup-inventory", "List env/flags by preferred stack");
	}
	if (/harness|pi|flue|self-improve/i.test(personaId + body)) {
		pushVerb("harness", "harness-inventory", "Inspect the documented agent harness");
	}
	const cursorGuide = map.commands.find(
		(command) => command.id === "guide" && command.argv.includes("--cursor"),
	);
	if (cursorGuide && /cursor/i.test(personaId + body)) {
		out.push({
			experienceId: "guide-cursor-map",
			intent: "Map Cursor features to product verbs",
			entryCommand: `${bin} ${cursorGuide.argv.join(" ")}`,
			driver: "cli",
			observableSuccess: "Cursor map with honest residual",
			observableFailure: "Claude-only guide with no cursor path",
			confusionRisks: [],
			priority: "P0",
			featureId: `${prod}-guide-cursor`,
			source: ["persona-goals", "surface-map.commands.guide"],
		});
	}
	if (/claude-code|app-builder/i.test(personaId + body)) {
		pushVerb("guide", "guide-claude-map", "Map Claude Code habits to product verbs");
	}
	if (/tmux|mosh|tailscale|attach|remote/i.test(personaId + body)) {
		pushVerb("attach", "remote-attach-dev-terminal", "Reattach dev-terminal / named endpoint");
	}
	if (/herdr|mux|pane|highlight/i.test(personaId + body)) {
		pushVerb("status", "status-inspection", "Inspect the documented status surface");
	}
	if (/grok|tasks|workflow/i.test(personaId + body)) {
		pushVerb("tasks", "tasks-board", "See background task board");
	}
	// Developer default: status + config if present
	if (/^developer$/i.test(personaId) || /cli conventions/i.test(body)) {
		pushVerb("status", "status-chrome", "Session/status chrome is scannable", "P1");
	}
	return out;
}

export function catalogPath(project: ProjectRef, root = repoRoot()): string {
	const base =
		!project.path || project.path === "." || project.id === "root"
			? path.join(root, ".optimizexp")
			: path.join(root, project.path, ".optimizexp");
	return path.join(base, "experience-catalog.json");
}

export function writeExperienceCatalog(
	catalog: ExperienceCatalog,
	project: ProjectRef,
	root = repoRoot(),
): string {
	const p = catalogPath(project, root);
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
	// human summary
	const md = [
		`# Experience catalog — ${catalog.projectId}`,
		"",
		`Built: ${catalog.builtAt}`,
		"",
		`Package-bin CLI: ${catalog.cliAssessment?.status ?? "unverified"} — ${catalog.cliAssessment?.evidence ?? "no manifest assessment"}.`,
		"This covers the package.json bin field only; other CLI and non-CLI surfaces are not assessed here.",
		`Surface validation: ${catalog.surfaceProblems?.length ? `unverified — ${catalog.surfaceProblems.join("; ")}` : catalog.surfaceProblems ? "no map problems" : "unverified — no validation result"}.`,
		"Map validation checks the recorded shape; it is not runtime evidence or complete experience coverage.",
		`Unverified persona goals: ${catalog.unverifiedGoals?.length ? catalog.unverifiedGoals.map((goal) => `${goal.personaId}: ${goal.goal} (${goal.reason})`).join("; ") : catalog.unverifiedGoals ? "none recorded" : "unknown"}.`,
		"",
		"| experienceId | persona | P | entry | featureId |",
		"|---|---|---|---|---|",
		...catalog.experiences.map(
			(e) =>
				`| ${e.experienceId} | ${e.personaId} | ${e.priority} | \`${e.entryCommand.replace(/\|/g, "\\|")}\` | ${e.featureId} |`,
		),
		"",
	].join("\n");
	writeFileSync(
		path.join(path.dirname(p), "EXPERIENCE-CATALOG.md"),
		md,
		"utf8",
	);
	return p;
}

export function readExperienceCatalog(
	project: ProjectRef,
	root = repoRoot(),
): ExperienceCatalog | null {
	const p = catalogPath(project, root);
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as ExperienceCatalog;
	} catch {
		return null;
	}
}

/** Every persona must have ≥1 P0. */
export function validateCatalogCoverage(
	catalog: ExperienceCatalog,
	personaIds: string[],
	map?: SurfaceMap,
	options?: { root: string; confirmedSurfaces?: string[]; freshProbe?: boolean },
): string[] {
	const problems: string[] = [];
	if (!map || !catalog.surfaceMapDigest || catalog.surfaceMapDigest !== surfaceMapDigest(map)) {
		return ["catalog is unverified or stale: surface map changed; rebuild the catalog"];
	}
	const assessment = catalog.cliAssessment;
	if (!assessment || assessment.scope !== "package.json bin" || typeof assessment.evidence !== "string" || !assessment.evidence.trim() || !["present", "not-applicable", "unverified"].includes(assessment.status)) {
		return ["package-bin CLI coverage is unverified: no manifest assessment"];
	}
	if (assessment.status === "unverified") {
		return [`package-bin CLI coverage is unverified: ${assessment.evidence}`];
	}
	if (!Array.isArray(catalog.surfaceProblems) || !catalog.surfaceProblems.every((problem) => typeof problem === "string")) {
		return ["surface discovery is unverified: no surface validation result"];
	}
	if (catalog.surfaceProblems.length) {
		return catalog.surfaceProblems.map((problem) => `surface discovery is unverified: ${problem}`);
	}
	if (assessment.status === "present") {
		if (!options) return ["surface observation is unverified: current executable and environment have not been checked"];
		const current = validateCurrentSurface(map, options.root, options);
		if (current.length) return current;
	}
	if (assessment.status === "not-applicable" && catalog.experiences.length === 0) {
		return [];
	}
	if (assessment.status === "present") {
		for (const goal of catalog.unverifiedGoals ?? []) {
			if (!personaIds.length || personaIds.includes(goal.personaId)) {
				problems.push(`persona ${goal.personaId} goal is unverified: ${goal.goal} (${goal.reason})`);
			}
		}
	}
	if (!catalog.experiences.some((e) => e.priority === "P0")) {
		problems.push("catalog has no P0 experiences");
	}
	for (const id of personaIds) {
		const p0 = catalog.experiences.filter(
			(e) => e.personaId === id && e.priority === "P0",
		);
		if (p0.length === 0) {
			problems.push(`persona ${id} has zero P0 experiences`);
		}
	}
	const hasDefault = catalog.experiences.some((e) =>
		e.experienceId.startsWith("cold-start"),
	);
	if (assessment.status === "present" && !hasDefault && catalog.experiences.length > 0) {
		problems.push("catalog missing cold-start default-entry experiences");
	}
	return problems;
}

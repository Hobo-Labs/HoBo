/**
 * Build persona × experience catalog from surface-map + persona files.
 * Critical input to high-quality feature generation.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mts";
import type { ProjectRef } from "./projects.mts";
import { readSurfaceMap, type SurfaceMap } from "./surface-map.mts";
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
	const bin = map.defaultEntry?.command ?? map.binaries[0]?.name ?? "app";
	const rows: ExperienceRow[] = [];
	const seen = new Set<string>();

	const add = (row: ExperienceRow) => {
		const k = `${row.experienceId}::${row.personaId}`;
		if (seen.has(k)) return;
		seen.add(k);
		rows.push(row);
	};

	for (const personaId of personaIds) {
		// P0: default entry
		if (map.defaultEntry || map.binaries.length) {
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
					? "Discoverability strip / HoBo branding; slash commands or help path visible"
					: "Helpful default or usage without silent hang",
				observableFailure: "Hang, empty chrome, or wrong-product branding only",
				confusionRisks: [
					"stock Pi / third-party agent UI",
					"wrong binary (control-plane vs coding harness)",
				],
				priority: "P0",
				featureId: `${prod}-default-entry`,
				source: ["surface-map.defaultEntry", "mandatory-p0"],
			});
			if (interactive) {
				add({
					experienceId: "in-session-discoverability",
					personaId,
					intent: "From inside the interactive session, find product surfaces without leaving",
					entryCommand: `${bin}  # then /verbs or in-session help`,
					driver: "tui",
					observableSuccess: "Slash commands list product verbs (agent/config/…)",
					observableFailure: "Only third-party defaults; no product map",
					confusionRisks: ["no slash commands for product surfaces"],
					priority: "P0",
					featureId: `${prod}-default-entry`,
					source: ["surface-map.interactiveSurfaces", "mandatory-p0"],
				});
			}
		}

		// P0: help
		add({
			experienceId: "help-discoverability",
			personaId,
			intent: "List verbs and next steps without tribal knowledge",
			entryCommand: map.nonInteractiveHelp?.command ?? `${bin} help`,
			driver: "cli",
			observableSuccess: "Verb list + First run / examples",
			observableFailure: "Empty help or wrong product help",
			confusionRisks: ["help dumps unrelated monorepo tooling"],
			priority: "P0",
			featureId: `${prod}-help-discoverability`,
			source: ["surface-map.nonInteractiveHelp", "mandatory-p0"],
		});

		// P0: failure path (generic bad verb)
		add({
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
	const bin = map.defaultEntry?.command ?? map.binaries[0]?.name ?? "app";
	const out: Omit<ExperienceRow, "personaId">[] = [];
	const cmd = (id: string) =>
		map.commands.find((c) => c.id === id) ?? { id, argv: [id], kind: "verb" };

	const pushVerb = (
		verb: string,
		experienceId: string,
		intent: string,
		priority: CatalogPriority = "P0",
	) => {
		if (!map.commands.some((c) => c.id === verb) && map.commands.length > 0) {
			// still allow if body strongly wants it
			if (!new RegExp(verb, "i").test(body) && !new RegExp(verb, "i").test(personaId)) {
				return;
			}
		}
		const c = cmd(verb);
		out.push({
			experienceId,
			intent,
			entryCommand: `${bin} ${c.argv.join(" ")}`,
			driver: "cli",
			observableSuccess: `Command ${verb} prints clear product chrome`,
			observableFailure: "Missing verb or opaque error",
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
	if (/cost|budget|\$0|free-local|open-source/i.test(personaId + body)) {
		pushVerb("cost", "cost-zero-path", "See $0 path, budget, savings without secrets");
	}
	if (/vim|neovim|editor-vim|cli-native/i.test(personaId + body)) {
		pushVerb("edit", "edit-nvim-bridge", "Open managed nvim pane / bridge contract");
	}
	if (/config|setup|stack|hermetic|nix|devenv/i.test(personaId + body)) {
		pushVerb("config", "config-setup-inventory", "List env/flags by preferred stack");
	}
	if (/harness|pi|flue|self-improve/i.test(personaId + body)) {
		pushVerb("harness", "harness-dual-surface", "See Pi/Flue dual surface + self-improve");
	}
	if (/cursor/i.test(personaId + body)) {
		out.push({
			experienceId: "guide-cursor-map",
			intent: "Map Cursor features to product verbs",
			entryCommand: `${bin} guide --cursor`,
			driver: "cli",
			observableSuccess: "Cursor map with honest residual",
			observableFailure: "Claude-only guide with no cursor path",
			confusionRisks: [],
			priority: "P0",
			featureId: `${prod}-guide-cursor`,
			source: ["persona-goals"],
		});
	}
	if (/claude-code|app-builder/i.test(personaId + body)) {
		pushVerb("guide", "guide-claude-map", "Map Claude Code habits to product verbs");
	}
	if (/tmux|mosh|tailscale|attach|remote/i.test(personaId + body)) {
		pushVerb("attach", "remote-attach-dev-terminal", "Reattach dev-terminal / named endpoint");
	}
	if (/herdr|mux|pane|highlight/i.test(personaId + body)) {
		pushVerb("status", "herdr-mux-status", "See multi-pane mux chrome + capabilities");
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
): string[] {
	const problems: string[] = [];
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
	if (!hasDefault && catalog.experiences.length > 0) {
		problems.push("catalog missing cold-start default-entry experiences");
	}
	return problems;
}

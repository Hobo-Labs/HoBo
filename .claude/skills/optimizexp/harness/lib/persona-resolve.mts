/**
 * Shared persona selection for --persona / --personas / experience intersection.
 * Reads global `.optimizexp/personas/` plus selected project-local
 * `<project>/.optimizexp/personas/` trees.
 * Project-local personas shadow global when the same id exists in both.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	GLOBAL_SCOPE_ID,
	globalScope,
	personasDir,
	relFromRepo,
	repoRoot,
	scopesForSelection,
	type OptimizexpScope,
} from "./paths.mts";
import type { ProjectSelection } from "./projects.mts";
import {
	parseExperienceTypesFromYaml,
	personaMatchesExperiences,
	type ExperienceType,
} from "./experience-types.mts";
import {
	applyPersonaConfigFilter,
	resolveConfig,
} from "./config.mts";

export type PersonaMeta = {
	id: string;
	/**
	 * Formal experience-type binding from frontmatter `experiences:`
	 * (alias `experienceTypes:`). Non-empty subset of ux | dx | ax.
	 * Persona is only selected when this intersects the run's experience set.
	 */
	experiences: ExperienceType[];
	/** Validation problems on the experiences field (empty = valid) */
	experienceProblems: string[];
	priority: number;
	interfaces: string[];
	/** Absolute path to the persona markdown file */
	path: string;
	/** `global` or project id */
	scopeId: string;
	/** Absolute path to the owning `.optimizexp/` */
	scopeDir: string;
	/** true when loaded from repo-root global tree */
	global: boolean;
	/** Repo-relative path for display */
	relPath: string;
	schemaVersion: 1 | 2;
	segmentIds: string[];
	marketPriority: number;
	generatedFromSeed: boolean;
	seedDigest: string | null;
	models: PersonaModels | null;
};

export type PersonaModels = {
	roleFamily: string;
	seniority: string;
	orgArchetype: string;
	domainFamiliarity: string;
	localeContext: string;
	deviceContext: string;
	timeBudget: string;
	accessibilityProfile: string;
	values: string[];
	riskTolerance: string;
	noveltySeeking: string;
	trustInAutomation: string;
	documentationPreference: string;
	errorEmotion: string;
	socialProofNeed: string;
	aestheticSensitivity: string;
	controlNeed: string;
	thresholds: Record<string, number>;
};

const COGNITIVE_CHANNELS = ["featureSprawl", "visualClutter", "interactiveClutter", "choiceOverload", "informationDensity", "noveltyTax", "contextSwitchTax", "workingMemoryLoad", "interruptionFragility"] as const;
const MODEL_KEYS = ["roleFamily", "seniority", "orgArchetype", "domainFamiliarity", "localeContext", "deviceContext", "timeBudget", "accessibilityProfile"] as const;

function section(text: string, heading: string): string {
	const start = text.search(new RegExp(`^## ${heading}\\s*$`, "mi"));
	if (start < 0) return "";
	const body = text.slice(start + text.slice(start).indexOf("\n") + 1);
	const next = body.search(/^## /mi);
	return (next < 0 ? body : body.slice(0, next)).trim();
}
function field(body: string, key: string): string {
	return body.match(new RegExp(`^- ${key}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? "";
}
function listField(body: string, key: string): string[] {
	const value = field(body, key).replace(/^\\[|\\]$/g, "");
	return value.split(",").map((v) => v.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

export function parsePersonaModels(text: string): { models: PersonaModels | null; problems: string[] } {
	const problems: string[] = [];
	const demo = section(text, "Demographic model");
	const psycho = section(text, "Psychographic model");
	const cognitive = section(text, "Cognitive thresholds");
	if (!demo || !psycho || !cognitive) return { models: null, problems: ["schemaVersion 2 requires structured demographic, psychographic, and cognitive models"] };
	const model = Object.fromEntries(MODEL_KEYS.map((k) => [k, field(demo, k)])) as Record<string, string>;
	for (const key of MODEL_KEYS) if (!model[key]) problems.push(`Demographic model missing ${key}`);
	const psychKeys = ["values", "riskTolerance", "noveltySeeking", "trustInAutomation", "documentationPreference", "errorEmotion", "socialProofNeed", "aestheticSensitivity", "controlNeed"];
	for (const key of psychKeys) if (!field(psycho, key)) problems.push(`Psychographic model missing ${key}`);
	const thresholds: Record<string, number> = {};
	for (const key of COGNITIVE_CHANNELS) {
		const n = Number(field(cognitive, key));
		if (!Number.isInteger(n) || n < 0 || n > 5) problems.push(`Cognitive threshold ${key} must be an integer 0..5`);
		else thresholds[key] = n;
	}
	const allowed = (key: string, values: string[]) => { if (field(demo, key) && !values.includes(field(demo, key))) problems.push(`${key} must be one of ${values.join(", ")}`); };
	allowed("roleFamily", ["application-developer", "platform", "design", "end-user", "agent-operator", "finops", "sre", "other"]);
	allowed("seniority", ["junior", "mid", "senior", "principal", "student", "hobbyist"]);
	allowed("orgArchetype", ["solo", "startup", "smb", "enterprise", "oss-community", "agency"]);
	allowed("domainFamiliarity", ["new-to-hobo", "migrating", "power-user"]);
	allowed("timeBudget", ["minutes", "hours", "multi-day"]);
	const level = (key: string) => ["low", "medium", "high"].includes(field(psycho, key));
	for (const key of ["riskTolerance", "noveltySeeking", "trustInAutomation", "socialProofNeed", "aestheticSensitivity", "controlNeed"]) if (!level(key)) problems.push(`${key} must be low, medium, or high`);
	if (Object.values(thresholds).every((v) => v === 5)) problems.push("cognitive thresholds cannot all be 5");
	if (model.seniority === "junior" && thresholds.informationDensity > 4) problems.push("junior personas need an informationDensity threshold <= 4");
	return { models: problems.length ? null : { ...model, values: listField(psycho, "values"), riskTolerance: field(psycho, "riskTolerance"), noveltySeeking: field(psycho, "noveltySeeking"), trustInAutomation: field(psycho, "trustInAutomation"), documentationPreference: field(psycho, "documentationPreference"), errorEmotion: field(psycho, "errorEmotion"), socialProofNeed: field(psycho, "socialProofNeed"), aestheticSensitivity: field(psycho, "aestheticSensitivity"), controlNeed: field(psycho, "controlNeed"), thresholds } as PersonaModels, problems };
}

export function personasDirGlobal(root = repoRoot()): string {
	return personasDir(globalScope(root));
}

/** @deprecated use personasDir(scope) — kept for call sites that only mean global */
export function personasDirLegacy(root = repoRoot()): string {
	return personasDirGlobal(root);
}

function parsePersonaFile(
	filePath: string,
	scope: OptimizexpScope,
	root: string,
): PersonaMeta | null {
	const text = readFileSync(filePath, "utf8");
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fm) return null;
	const yaml = fm[1]!;
	const schemaVersion = Number(yaml.match(/^schemaVersion:\s*(\d+)/m)?.[1] || 1) as 1 | 2;
	const base = path.basename(filePath, ".md");
	const id = yaml.match(/^id:\s*(\S+)/m)?.[1] || base;
	const expParsed = parseExperienceTypesFromYaml(yaml);
	const priority = Number(yaml.match(/^priority:\s*(\d+)/m)?.[1] || 100);
	const intRaw = yaml.match(/^interfaces:\s*\[([^\]]*)\]/m)?.[1] || "";
	const interfaces = intRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const segmentIds = (yaml.match(/^segmentIds:\s*\[([^\]]*)\]/m)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const marketPriority = Number(yaml.match(/^marketPriority:\s*(\d+)/m)?.[1] ?? priority);
	const generatedFromSeed = /^generatedFromSeed:\s*true\s*$/m.test(yaml);
	const seedDigest = yaml.match(/^seedDigest:\s*["']?([a-f0-9]{8,64})["']?\s*$/mi)?.[1] ?? null;
	const modelsResult = schemaVersion === 2 ? parsePersonaModels(text.slice(fm[0].length)) : { models: null, problems: [] };
	// Optional frontmatter scope override (must match folder if set)
	const fmScope = yaml.match(/^scope:\s*(\S+)/m)?.[1];
	const scopeId = fmScope || scope.id;
	return {
		id,
		experiences: expParsed.ok,
		experienceProblems: [...expParsed.problems, ...modelsResult.problems],
		priority,
		interfaces,
		path: filePath,
		scopeId,
		scopeDir: scope.optimizexpDir,
		global: scope.global,
		relPath: relFromRepo(filePath, root),
		schemaVersion, segmentIds, marketPriority, generatedFromSeed, seedDigest,
		models: modelsResult.models,
	};
}

function listPersonasInScope(
	scope: OptimizexpScope,
	root: string,
): PersonaMeta[] {
	const dir = personasDir(scope);
	if (!existsSync(dir)) return [];
	const out: PersonaMeta[] = [];
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
		const meta = parsePersonaFile(path.join(dir, f), scope, root);
		if (meta) out.push(meta);
	}
	return out;
}

/**
 * List personas for a project selection.
 * Always includes **global**; merges selected project scopes.
 * **Shadowing:** project-local id wins over global when both exist.
 */
export function listPersonaMetas(
	root = repoRoot(),
	selection?: ProjectSelection,
): PersonaMeta[] {
	const scopes = scopesForSelection(selection, root);
	const byId = new Map<string, PersonaMeta>();
	// Global first
	for (const s of scopes.filter((x) => x.global)) {
		for (const m of listPersonasInScope(s, root)) {
			byId.set(m.id, m);
		}
	}
	// Project scopes overwrite
	for (const s of scopes.filter((x) => !x.global)) {
		for (const m of listPersonasInScope(s, root)) {
			byId.set(m.id, m);
		}
	}
	return [...byId.values()].sort(
		(a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
	);
}

/**
 * Resolve which personas participate in this invocation.
 * Matches skill flag resolution (after persona seeds have been written to disk).
 */
export function resolvePersonaIds(input: {
	/** Explicit --personas / --use-personas */
	personasFlag?: string[];
	/** Ids generated this run via --persona seeds */
	generatedIds?: string[];
	/** Resolved experience set */
	experiences: string[];
	maxPersonas?: number;
	root?: string;
	/** Multi-project selection — controls which project .optimizexp trees are scanned */
	selection?: ProjectSelection;
	/** Skip loading config prefer/exclude */
	skipConfig?: boolean;
}): { ids: string[]; reason: string; metas: PersonaMeta[] } {
	const root = input.root ?? repoRoot();
	const all = listPersonaMetas(root, input.selection);
	const byId = new Map(all.map((m) => [m.id, m]));
	let ids: string[] = [];
	let reason = "";

	const focusProject =
		input.selection &&
		!input.selection.allProjects &&
		input.selection.projects.length === 1
			? input.selection.projects[0]!
			: null;
	const cfg = input.skipConfig
		? null
		: resolveConfig({ root, focusProject }).resolved;

	if (input.personasFlag && input.personasFlag.length > 0) {
		ids = [...input.personasFlag];
		reason = "explicit --personas";
		const missing = ids.filter((id) => !byId.has(id));
		if (missing.length) {
			throw new Error(
				`Unknown persona id(s): ${missing.join(", ")}. Generate with --persona or add personas under global .optimizexp/personas/ or <project>/.optimizexp/personas/`,
			);
		}
		const invalid = ids.filter((id) => (byId.get(id)?.experienceProblems.length ?? 0) > 0);
		if (invalid.length) throw new Error(`Persona id(s) failed schema validation: ${invalid.join(", ")}`);
	} else if (input.generatedIds && input.generatedIds.length > 0) {
		ids = [...input.generatedIds];
		reason = "generated this invocation via --persona";
	} else {
		// Formal binding: persona.experiences ∩ run experiences ≠ ∅.
		const valid = all.filter((m) => m.experiences.length > 0 && m.experienceProblems.length === 0);
		ids = valid
			.filter((m) =>
				personaMatchesExperiences(m.experiences, input.experiences),
			)
			.map((m) => m.id);
		reason =
			"personas whose frontmatter experiences ∩ [" +
			input.experiences.join(",") +
			"] (formal experienceTypes binding; global + project scopes)";
		if (ids.length === 0) {
			const invalidCount = all.filter((m) => m.experiences.length === 0).length;
			reason +=
				`; zero matches` +
				(invalidCount
					? ` (${invalidCount} persona(s) missing valid experiences: frontmatter)`
					: "");
		}
	}

	if (cfg) {
		ids = applyPersonaConfigFilter(ids, cfg);
		const cfgSources = cfg.sources.filter(
			(s) => s !== "<skill-builtin-defaults>",
		);
		if (cfgSources.length || cfg.personas.prefer.length || cfg.personas.exclude.length) {
			reason += `; config prefer/exclude (${cfgSources.join(" + ") || "builtins"})`;
		}
	}

	if (!cfg?.personas.prefer.length) {
		ids = [...new Set(ids)].sort((a, b) => {
			const pa = byId.get(a)?.priority ?? 100;
			const pb = byId.get(b)?.priority ?? 100;
			return pa - pb || a.localeCompare(b);
		});
	} else {
		ids = [...new Set(ids)];
	}

	const maxCap =
		input.maxPersonas && input.maxPersonas > 0
			? input.maxPersonas
			: cfg?.defaults.maxPersonas;
	if (maxCap && maxCap > 0 && ids.length > maxCap) {
		ids = ids.slice(0, maxCap);
		reason += `; truncated to maxPersonas=${maxCap}`;
	}

	const metas = ids.map((id) => byId.get(id)!).filter(Boolean);
	return { ids, reason, metas };
}

export function findPersona(
	id: string,
	root = repoRoot(),
	selection?: ProjectSelection,
): PersonaMeta | null {
	return listPersonaMetas(root, selection).find((m) => m.id === id) ?? null;
}

export { GLOBAL_SCOPE_ID };

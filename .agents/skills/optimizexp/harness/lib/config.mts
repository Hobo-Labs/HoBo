/**
 * Formal OptimizeXP config for global + project `.optimizexp/` trees.
 *
 * Files (optional — skill works with zero config):
 *   .optimizexp/config.json              # global
 *   <project>/.optimizexp/config.json    # project
 *
 * Merge (later wins on scalar/object keys; arrays replace unless noted):
 *   skill built-in defaults
 *   < global config
 *   < project config (when a single project is the write/focus scope)
 *   < CLI flags / env (callers apply; not stored here)
 *
 * Adversarial non-goals (do NOT put in config):
 *   secrets, tokens, live cloud credentials
 *   bus/runs ownership (always global)
 *   full CLI grammar duplication
 *   mandatory files (absence = defaults)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	EXPERIENCE_TYPES,
	normalizeExperienceTokens,
	type ExperienceType,
} from "./experience-types.mts";
import {
	globalOptimizexpRoot,
	globalScope,
	relFromRepo,
	repoRoot,
	scopeForProject,
	type OptimizexpScope,
} from "./paths.mts";
import type { ProjectRef, ProjectSelection } from "./projects.mts";
import {
	mergeGitignoreConfig,
	skillBuiltinGitignoreConfig,
	type OptimizexpGitignoreConfig,
} from "./gitignore.mts";

export const CONFIG_SCHEMA_VERSION = 1 as const;
export const CONFIG_FILENAME = "config.json";
export type { OptimizexpGitignoreConfig };

export type OptimizexpConfigKind = "global" | "project";

export type OptimizexpDefaults = {
	/** Default experience tracks when CLI omits --ux/--dx/--ax */
	experiences: ExperienceType[];
	/** Default project selection: "all" or explicit ids */
	projects: "all" | string[];
	/** Outer harm cycles: "infinite" or positive int */
	passes: "infinite" | number;
	/** Enter delight regime after harm floor */
	delight: boolean;
	/** End-of-run persona survey */
	survey: boolean;
	/** Measure-only mode default */
	reportOnly: boolean;
	/** Init / resolve caps */
	maxPersonas: number;
	maxFeatures: number;
	/** Default capture driver when feature.json omits driver */
	driver: "cli" | "tui" | "web" | "native" | "mixed";
};

export type OptimizexpEvidenceConfig = {
	preferVideo: boolean;
	overwritePrimary: boolean;
	/** Base URL for web capture (project-level especially) */
	baseUrl?: string;
	/** Env var name holding native capture command */
	nativeCaptureEnv: string;
};

export type OptimizexpSafetyConfig = {
	/** Offline-first: skip live/egress scripts unless seed opts in */
	forbidLiveNetworkByDefault: boolean;
	/** Allow persona-path `pnpm install` / setup scripts when cold */
	allowLocalInstall: boolean;
};

export type OptimizexpPersonasConfig = {
	/** Prefer schemaVersion >= this on new/rewritten personas */
	requireSchemaVersion: 1 | 2;
	defaultPriority: number;
	/** Prefer these ids when resolving without --personas (after experience filter) */
	prefer?: string[];
	/** Never auto-select these ids */
	exclude?: string[];
};

export type OptimizexpFeaturesConfig = {
	defaultDriver: OptimizexpDefaults["driver"];
	/** When validating cucumber / capture, also scan project trees */
	includeProjectFeatureGlobs: boolean;
	prefer?: string[];
	exclude?: string[];
};

export type OptimizexpSurfacesConfig = {
	/** Named commands useful for init discovery / feature seeds */
	commands?: Record<string, string>;
	/** Primary URL for web surfaces */
	primaryUrl?: string;
};

export type OptimizexpProductConfig = {
	name?: string;
	summary?: string;
};

export type OptimizexpProjectsRegistry = {
	/** If non-empty, only these project ids are discovered/selected by default */
	include?: string[];
	/** Drop these ids from discovery (globs not supported — exact ids) */
	exclude?: string[];
};

/**
 * Full config document (global or project).
 * Project files should set kind: "project" and projectId.
 */
export type OptimizexpConfig = {
	schemaVersion: typeof CONFIG_SCHEMA_VERSION;
	kind: OptimizexpConfigKind;
	/** Required when kind === "project" */
	projectId?: string;
	label?: string;
	product?: OptimizexpProductConfig;
	defaults?: Partial<OptimizexpDefaults>;
	personas?: OptimizexpPersonasConfig;
	features?: OptimizexpFeaturesConfig;
	evidence?: Partial<OptimizexpEvidenceConfig>;
	safety?: Partial<OptimizexpSafetyConfig>;
	surfaces?: OptimizexpSurfacesConfig;
	projects?: OptimizexpProjectsRegistry;
	/** Managed .gitignore patterns for this optimizexp tree */
	gitignore?: OptimizexpGitignoreConfig;
	/** Free-form notes for agents (not machine-enforced) */
	notes?: string[];
};

/** Fully resolved effective config after merge. */
export type ResolvedOptimizexpConfig = {
	schemaVersion: typeof CONFIG_SCHEMA_VERSION;
	kind: OptimizexpConfigKind;
	projectId: string | null;
	label: string | null;
	product: OptimizexpProductConfig;
	defaults: OptimizexpDefaults;
	personas: Required<
		Pick<OptimizexpPersonasConfig, "requireSchemaVersion" | "defaultPriority">
	> & {
		prefer: string[];
		exclude: string[];
	};
	features: Required<
		Pick<OptimizexpFeaturesConfig, "defaultDriver" | "includeProjectFeatureGlobs">
	> & {
		prefer: string[];
		exclude: string[];
	};
	evidence: OptimizexpEvidenceConfig;
	safety: OptimizexpSafetyConfig;
	surfaces: OptimizexpSurfacesConfig;
	projects: {
		include: string[];
		exclude: string[];
	};
	gitignore: OptimizexpGitignoreConfig;
	notes: string[];
	/** Repo-relative paths of files that contributed */
	sources: string[];
};

export function skillBuiltinDefaults(): ResolvedOptimizexpConfig {
	return {
		schemaVersion: CONFIG_SCHEMA_VERSION,
		kind: "global",
		projectId: null,
		label: null,
		product: {},
		defaults: {
			experiences: [...EXPERIENCE_TYPES],
			projects: "all",
			passes: "infinite",
			delight: true,
			survey: true,
			reportOnly: false,
			maxPersonas: 12,
			maxFeatures: 12,
			driver: "cli",
		},
		personas: {
			requireSchemaVersion: 2,
			defaultPriority: 50,
			prefer: [],
			exclude: [],
		},
		features: {
			defaultDriver: "cli",
			includeProjectFeatureGlobs: true,
			prefer: [],
			exclude: [],
		},
		evidence: {
			preferVideo: true,
			overwritePrimary: true,
			nativeCaptureEnv: "OPTIMIZEXP_NATIVE_CAPTURE",
		},
		safety: {
			forbidLiveNetworkByDefault: true,
			allowLocalInstall: true,
		},
		surfaces: {},
		projects: { include: [], exclude: [] },
		gitignore: skillBuiltinGitignoreConfig("global"),
		notes: [],
		sources: ["<skill-builtin-defaults>"],
	};
}

export function configPathForScope(scope: OptimizexpScope): string {
	return path.join(scope.optimizexpDir, CONFIG_FILENAME);
}

export function globalConfigPath(root = repoRoot()): string {
	return configPathForScope(globalScope(root));
}

export function projectConfigPath(
	project: ProjectRef,
	root = repoRoot(),
): string {
	return configPathForScope(scopeForProject(project, root));
}

export type LoadConfigResult = {
	config: OptimizexpConfig | null;
	path: string;
	problems: string[];
	exists: boolean;
};

export function loadConfigFile(filePath: string): LoadConfigResult {
	if (!existsSync(filePath)) {
		return { config: null, path: filePath, problems: [], exists: false };
	}
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		const problems = validateConfigDocument(raw, filePath);
		if (problems.some((p) => p.startsWith("fatal:"))) {
			return {
				config: null,
				path: filePath,
				problems,
				exists: true,
			};
		}
		return {
			config: raw as OptimizexpConfig,
			path: filePath,
			problems,
			exists: true,
		};
	} catch (e) {
		return {
			config: null,
			path: filePath,
			problems: [`fatal: invalid JSON: ${String(e)}`],
			exists: true,
		};
	}
}

export function validateConfigDocument(
	raw: unknown,
	filePath = "<config>",
): string[] {
	const problems: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return [`fatal: ${filePath} must be a JSON object`];
	}
	const o = raw as Record<string, unknown>;
	if (o.schemaVersion !== CONFIG_SCHEMA_VERSION) {
		problems.push(
			`schemaVersion must be ${CONFIG_SCHEMA_VERSION} (got ${String(o.schemaVersion)})`,
		);
	}
	if (o.kind !== "global" && o.kind !== "project") {
		problems.push(`kind must be "global" or "project" (got ${String(o.kind)})`);
	}
	if (o.kind === "project" && (!o.projectId || typeof o.projectId !== "string")) {
		problems.push(`kind "project" requires string projectId`);
	}
	if (o.defaults && typeof o.defaults === "object" && !Array.isArray(o.defaults)) {
		const d = o.defaults as Record<string, unknown>;
		if (d.experiences != null) {
			const exp = Array.isArray(d.experiences)
				? (d.experiences as string[])
				: [];
			const parsed = normalizeExperienceTokens(exp, "experiences");
			problems.push(
				...parsed.problems.map((p) => `defaults.experiences: ${p}`),
			);
		}
		if (d.passes != null && d.passes !== "infinite" && typeof d.passes !== "number") {
			problems.push(`defaults.passes must be "infinite" or a number`);
		}
		if (
			d.driver != null &&
			!["cli", "tui", "web", "native", "mixed"].includes(String(d.driver))
		) {
			problems.push(`defaults.driver invalid: ${String(d.driver)}`);
		}
	}
	// Soft: unknown top-level keys are allowed for forward-compat but note them
	const known = new Set([
		"schemaVersion",
		"kind",
		"projectId",
		"label",
		"product",
		"defaults",
		"personas",
		"features",
		"evidence",
		"safety",
		"surfaces",
		"projects",
		"gitignore",
		"notes",
	]);
	for (const k of Object.keys(o)) {
		if (!known.has(k)) {
			problems.push(`unknown key "${k}" (ignored by harness; remove or document)`);
		}
	}
	return problems;
}

function deepMergeDefaults(
	base: OptimizexpDefaults,
	patch?: Partial<OptimizexpDefaults>,
): OptimizexpDefaults {
	if (!patch) return { ...base, experiences: [...base.experiences] };
	const experiences =
		patch.experiences != null
			? normalizeExperienceTokens(
					patch.experiences as string[],
					"experiences",
				).ok
			: [...base.experiences];
	return {
		experiences: experiences.length ? experiences : [...base.experiences],
		projects: patch.projects ?? base.projects,
		passes: patch.passes ?? base.passes,
		delight: patch.delight ?? base.delight,
		survey: patch.survey ?? base.survey,
		reportOnly: patch.reportOnly ?? base.reportOnly,
		maxPersonas: patch.maxPersonas ?? base.maxPersonas,
		maxFeatures: patch.maxFeatures ?? base.maxFeatures,
		driver: patch.driver ?? base.driver,
	};
}

function mergePartial<T extends object>(base: T, patch?: Partial<T>): T {
	if (!patch) return { ...base };
	return { ...base, ...patch };
}

/**
 * Resolve effective config for a run/write scope.
 * - Always loads global `.optimizexp/config.json` if present.
 * - When `focusProject` is a single non-root project, merges its config on top.
 * - Multi-project / all-projects: global only (project configs apply when that project is write focus).
 */
export function resolveConfig(input?: {
	root?: string;
	focusProject?: ProjectRef | null;
	selection?: ProjectSelection;
}): {
	resolved: ResolvedOptimizexpConfig;
	problems: string[];
} {
	const root = input?.root ?? repoRoot();
	const problems: string[] = [];
	let resolved = skillBuiltinDefaults();
	const sources = [...resolved.sources];

	const globalFile = loadConfigFile(globalConfigPath(root));
	problems.push(...globalFile.problems.map((p) => `global: ${p}`));
	if (globalFile.config) {
		resolved = applyConfigDocument(resolved, globalFile.config, "global");
		sources.push(relFromRepo(globalFile.path, root));
	}

	const focus = input?.focusProject;
	if (focus && focus.path && focus.kind !== "root") {
		const projFile = loadConfigFile(projectConfigPath(focus, root));
		problems.push(
			...projFile.problems.map((p) => `project(${focus.id}): ${p}`),
		);
		if (projFile.config) {
			if (
				projFile.config.projectId &&
				projFile.config.projectId !== focus.id
			) {
				problems.push(
					`project(${focus.id}): config.projectId "${projFile.config.projectId}" != folder project id`,
				);
			}
			resolved = applyConfigDocument(resolved, projFile.config, "project");
			resolved.kind = "project";
			resolved.projectId = focus.id;
			resolved.label = projFile.config.label ?? focus.label;
			sources.push(relFromRepo(projFile.path, root));
		} else {
			// No file: still mark focus identity for callers
			resolved.kind = "project";
			resolved.projectId = focus.id;
			resolved.label = focus.label;
		}
	}

	resolved.sources = sources;
	return { resolved, problems };
}

function applyConfigDocument(
	base: ResolvedOptimizexpConfig,
	doc: OptimizexpConfig,
	_layer: "global" | "project",
): ResolvedOptimizexpConfig {
	const next: ResolvedOptimizexpConfig = {
		...base,
		product: { ...base.product, ...doc.product },
		defaults: deepMergeDefaults(base.defaults, doc.defaults),
		personas: {
			requireSchemaVersion:
				doc.personas?.requireSchemaVersion ?? base.personas.requireSchemaVersion,
			defaultPriority:
				doc.personas?.defaultPriority ?? base.personas.defaultPriority,
			prefer: doc.personas?.prefer ?? base.personas.prefer,
			exclude: [
				...new Set([
					...(base.personas.exclude ?? []),
					...(doc.personas?.exclude ?? []),
				]),
			],
		},
		features: {
			defaultDriver:
				doc.features?.defaultDriver ??
				doc.defaults?.driver ??
				base.features.defaultDriver,
			includeProjectFeatureGlobs:
				doc.features?.includeProjectFeatureGlobs ??
				base.features.includeProjectFeatureGlobs,
			prefer: doc.features?.prefer ?? base.features.prefer,
			exclude: [
				...new Set([
					...(base.features.exclude ?? []),
					...(doc.features?.exclude ?? []),
				]),
			],
		},
		evidence: mergePartial(base.evidence, doc.evidence),
		safety: mergePartial(base.safety, doc.safety),
		surfaces: {
			...base.surfaces,
			...doc.surfaces,
			commands: {
				...base.surfaces.commands,
				...doc.surfaces?.commands,
			},
		},
		projects: {
			include: doc.projects?.include ?? base.projects.include,
			exclude: [
				...new Set([
					...base.projects.exclude,
					...(doc.projects?.exclude ?? []),
				]),
			],
		},
		gitignore: mergeGitignoreConfig(
			// When applying a project layer, start from project builtins for runs/bus=false
			doc.kind === "project"
				? skillBuiltinGitignoreConfig("project")
				: base.gitignore,
			doc.gitignore,
		),
		notes: [...base.notes, ...(doc.notes ?? [])],
		sources: base.sources,
		schemaVersion: CONFIG_SCHEMA_VERSION,
		kind: doc.kind ?? base.kind,
		projectId: doc.projectId ?? base.projectId,
		label: doc.label ?? base.label,
	};
	// prefer lists: project replaces when provided
	if (doc.personas?.prefer) next.personas.prefer = [...doc.personas.prefer];
	if (doc.features?.prefer) next.features.prefer = [...doc.features.prefer];
	return next;
}

/** Order `ids` so `prefer` list order comes first, then remaining. */
function orderByPrefer(ids: string[], prefer: string[]): string[] {
	if (!prefer.length) return ids;
	const set = new Set(ids);
	const head = prefer.filter((id) => set.has(id));
	const headSet = new Set(head);
	const tail = ids.filter((id) => !headSet.has(id));
	return [...head, ...tail];
}

/** Filter persona ids by config prefer/exclude (after experience intersection). */
export function applyPersonaConfigFilter(
	ids: string[],
	cfg: ResolvedOptimizexpConfig,
): string[] {
	const exclude = new Set(cfg.personas.exclude);
	const filtered = ids.filter((id) => !exclude.has(id));
	return orderByPrefer(filtered, cfg.personas.prefer);
}

/** Filter feature ids by config prefer/exclude. */
export function applyFeatureConfigFilter(
	ids: string[],
	cfg: ResolvedOptimizexpConfig,
): string[] {
	const exclude = new Set(cfg.features.exclude);
	const filtered = ids.filter((id) => !exclude.has(id));
	return orderByPrefer(filtered, cfg.features.prefer);
}

export function writeConfigFile(
	filePath: string,
	config: OptimizexpConfig,
	opts?: { force?: boolean },
): void {
	if (existsSync(filePath) && !opts?.force) {
		throw new Error(`config exists (use force): ${filePath}`);
	}
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Minimal sensible global config for a monorepo (no secrets). */
export function defaultGlobalConfigDocument(input?: {
	productName?: string;
	productSummary?: string;
}): OptimizexpConfig {
	return {
		schemaVersion: CONFIG_SCHEMA_VERSION,
		kind: "global",
		label: "Repository-wide OptimizeXP",
		product: {
			name: input?.productName,
			summary: input?.productSummary,
		},
		defaults: {
			experiences: ["ux", "dx", "ax"],
			projects: "all",
			passes: "infinite",
			delight: true,
			survey: true,
			reportOnly: false,
			maxPersonas: 12,
			maxFeatures: 12,
			driver: "cli",
		},
		personas: {
			requireSchemaVersion: 2,
			defaultPriority: 50,
		},
		features: {
			defaultDriver: "cli",
			includeProjectFeatureGlobs: true,
		},
		evidence: {
			preferVideo: true,
			overwritePrimary: true,
			nativeCaptureEnv: "OPTIMIZEXP_NATIVE_CAPTURE",
		},
		safety: {
			forbidLiveNetworkByDefault: true,
			allowLocalInstall: true,
		},
		gitignore: skillBuiltinGitignoreConfig("global"),
		notes: [
			"Global config owns monorepo defaults + bus/runs live under this tree.",
			"Project configs live at <project>/.optimizexp/config.json and override defaults for that product surface.",
			"CLI flags always win over this file.",
			"gitignore: managed .gitignore ignores runs/, bus entries, large evidence media — customize via gitignore.extra/negate.",
		],
	};
}

/** Minimal project config template. */
export function defaultProjectConfigDocument(
	projectId: string,
	opts?: {
		label?: string;
		experiences?: ExperienceType[];
		driver?: OptimizexpDefaults["driver"];
		primaryUrl?: string;
		commands?: Record<string, string>;
	},
): OptimizexpConfig {
	return {
		schemaVersion: CONFIG_SCHEMA_VERSION,
		kind: "project",
		projectId,
		label: opts?.label ?? projectId,
		defaults: {
			experiences: opts?.experiences ?? ["ux", "dx", "ax"],
			driver: opts?.driver ?? "cli",
		},
		features: {
			defaultDriver: opts?.driver ?? "cli",
			includeProjectFeatureGlobs: true,
		},
		evidence: {
			preferVideo: true,
			overwritePrimary: true,
			baseUrl: opts?.primaryUrl,
			nativeCaptureEnv: "OPTIMIZEXP_NATIVE_CAPTURE",
		},
		surfaces: {
			primaryUrl: opts?.primaryUrl,
			commands: opts?.commands,
		},
		gitignore: skillBuiltinGitignoreConfig("project"),
		notes: [
			`Project-local personas/features live beside this file under ${projectId}/.optimizexp/.`,
			"Bus/runs/backlog stay in the repo-root global .optimizexp/.",
			"Project .gitignore ignores large evidence media by default.",
		],
	};
}

/** Ensure global config exists (init); never overwrites unless force. */
export function ensureGlobalConfig(
	root = repoRoot(),
	opts?: { force?: boolean; productName?: string; productSummary?: string },
): { path: string; created: boolean } {
	const p = globalConfigPath(root);
	if (existsSync(p) && !opts?.force) {
		return { path: p, created: false };
	}
	writeConfigFile(
		p,
		defaultGlobalConfigDocument({
			productName: opts?.productName,
			productSummary: opts?.productSummary,
		}),
		{ force: true },
	);
	return { path: p, created: true };
}

export function ensureProjectConfig(
	project: ProjectRef,
	root = repoRoot(),
	opts?: {
		force?: boolean;
		experiences?: ExperienceType[];
		driver?: OptimizexpDefaults["driver"];
		primaryUrl?: string;
		commands?: Record<string, string>;
	},
): { path: string; created: boolean } {
	const p = projectConfigPath(project, root);
	if (existsSync(p) && !opts?.force) {
		return { path: p, created: false };
	}
	if (!project.path || project.kind === "root") {
		// root project uses global config only
		return ensureGlobalConfig(root, opts);
	}
	writeConfigFile(
		p,
		defaultProjectConfigDocument(project.id, {
			label: project.label,
			experiences: opts?.experiences,
			driver: opts?.driver,
			primaryUrl: opts?.primaryUrl,
			commands: opts?.commands,
		}),
		{ force: true },
	);
	return { path: p, created: true };
}

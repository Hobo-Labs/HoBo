/**
 * OptimizeXP doctor: audit + safe repair of optimizexp workspace structure,
 * snapshots, feature quality, and persona formalization.
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
	featuresRoot,
	globalOptimizexpRoot,
	globalScope,
	listFeatures,
	personasDir,
	relFromRepo,
	repoRoot,
	scopeForProject,
	scopesForSelection,
	type OptimizexpScope,
} from "./paths.mts";
import {
	listProjects,
	resolveProjects,
	type ProjectRef,
	type ProjectSelection,
} from "./projects.mts";
import {
	ensureGlobalConfig,
	ensureProjectConfig,
	globalConfigPath,
	loadConfigFile,
	projectConfigPath,
} from "./config.mts";
import {
	ensureGlobalGitignore,
	ensureProjectGitignore,
	skillBuiltinGitignoreConfig,
} from "./gitignore.mts";
import { listPersonaMetas, type PersonaMeta } from "./persona-resolve.mts";
import {
	checkGherkinQuality,
	checkRubberduckFile,
} from "./feature-quality.mts";
import {
	readSurfaceMap,
	validateSurfaceMap,
	buildSurfaceMap,
	writeSurfaceMap,
} from "./surface-map.mts";
import {
	buildExperienceCatalog,
	readExperienceCatalog,
	validateCatalogCoverage,
	writeExperienceCatalog,
} from "./experience-catalog.mts";

export type DoctorSeverity = "error" | "warn" | "info";

export type DoctorFinding = {
	id: string;
	severity: DoctorSeverity;
	scope: string;
	message: string;
	/** Safe automated repair available */
	repairable: boolean;
	repairAction?: string;
	path?: string;
};

export type DoctorReport = {
	ok: boolean;
	scannedAt: string;
	root: string;
	mode: "check" | "repair" | "snapshot";
	findings: DoctorFinding[];
	repairsApplied: string[];
	snapshotPath?: string;
	summary: {
		errors: number;
		warns: number;
		infos: number;
		repairable: number;
	};
};

function find(id: string, severity: DoctorSeverity, scope: string, message: string, extra: Partial<DoctorFinding> = {}): DoctorFinding {
	return {
		id,
		severity,
		scope,
		message,
		repairable: false,
		...extra,
	};
}

function ensureDir(p: string): void {
	mkdirSync(p, { recursive: true });
}

function ensureGitkeep(dir: string): void {
	ensureDir(dir);
	const gk = path.join(dir, ".gitkeep");
	if (!existsSync(gk)) writeFileSync(gk, "", "utf8");
}

const PERSONA_SECTIONS_V1 = [
	"## Who I am",
	"## Goals",
	"## Constraints",
	"## Accessibility",
	"## Success looks like",
	"## Failure modes",
	"## Vocabulary",
	"## Review instructions",
];

const PERSONA_SECTIONS_V2 = [
	"## Market segment",
	"## Demographic model",
	"## Psychographic model",
	"## Cognitive thresholds",
];

function auditPersonaFile(
	meta: PersonaMeta,
	root: string,
): DoctorFinding[] {
	const out: DoctorFinding[] = [];
	const text = readFileSync(meta.path, "utf8");
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fm) {
		out.push(
			find(
				"persona-no-frontmatter",
				"error",
				meta.scopeId,
				`Persona ${meta.id} missing YAML frontmatter`,
				{ path: meta.relPath, repairable: false },
			),
		);
		return out;
	}
	const yaml = fm[1]!;
	const schemaVersion = yaml.match(/^schemaVersion:\s*(\d+)/m)?.[1];
	if (schemaVersion !== "1" && schemaVersion !== "2") {
		out.push(
			find(
				"persona-schema",
				"error",
				meta.scopeId,
				`Persona ${meta.id}: schemaVersion must be 1 or 2`,
				{ path: meta.relPath, repairable: true, repairAction: "persona-schema-v2" },
			),
		);
	}
	if (meta.experienceProblems.length) {
		out.push(
			find(
				"persona-experiences",
				"error",
				meta.scopeId,
				`Persona ${meta.id}: ${meta.experienceProblems.join("; ")}`,
				{ path: meta.relPath, repairable: true, repairAction: "persona-experiences-default" },
			),
		);
	}
	if (meta.experiences.length === 0) {
		out.push(
			find(
				"persona-experiences-empty",
				"error",
				meta.scopeId,
				`Persona ${meta.id}: experiences: binding empty — will never be selected`,
				{ path: meta.relPath, repairable: true, repairAction: "persona-experiences-default" },
			),
		);
	}
	const idFm = yaml.match(/^id:\s*(\S+)/m)?.[1];
	if (idFm && idFm !== meta.id) {
		out.push(
			find(
				"persona-id-mismatch",
				"warn",
				meta.scopeId,
				`Persona file basename ${meta.id} != frontmatter id ${idFm}`,
				{ path: meta.relPath },
			),
		);
	}
	for (const sec of PERSONA_SECTIONS_V1) {
		if (!text.includes(sec.split(" ")[0]! + " ") && !new RegExp(sec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) {
			// softer: check key words
			const key = sec.replace(/^##\s*/, "").split(" ")[0]!;
			if (!new RegExp(`##\\s*${key}`, "i").test(text)) {
				out.push(
					find(
						`persona-section-${key.toLowerCase()}`,
						"warn",
						meta.scopeId,
						`Persona ${meta.id}: missing section like "${sec}"`,
						{ path: meta.relPath, repairable: false },
					),
				);
			}
		}
	}
	if (schemaVersion === "2" || !schemaVersion) {
		for (const sec of PERSONA_SECTIONS_V2) {
			const key = sec.replace(/^##\s*/, "");
			if (!new RegExp(`##\\s*${key}`, "i").test(text)) {
				out.push(
					find(
						`persona-v2-${key.toLowerCase().replace(/\s+/g, "-")}`,
						schemaVersion === "2" ? "error" : "warn",
						meta.scopeId,
						`Persona ${meta.id}: schema v2 expects "${sec}"`,
						{
							path: meta.relPath,
							repairable: true,
							repairAction: "persona-v2-sections",
						},
					),
				);
			}
		}
		if (!/^segmentIds:/m.test(yaml) && schemaVersion === "2") {
			out.push(
				find(
					"persona-segmentIds",
					"error",
					meta.scopeId,
					`Persona ${meta.id}: schemaVersion 2 requires segmentIds`,
					{ path: meta.relPath, repairable: true, repairAction: "persona-segmentIds" },
				),
			);
		}
	}
	if (text.length < 400) {
		out.push(
			find(
				"persona-thin",
				"warn",
				meta.scopeId,
				`Persona ${meta.id}: body very short (<400 chars) — formalize before review`,
				{ path: meta.relPath },
			),
		);
	}
	void root;
	return out;
}

function auditFeatureDir(
	featureId: string,
	dir: string,
	scopeId: string,
	root: string,
): DoctorFinding[] {
	const out: DoctorFinding[] = [];
	const rel = relFromRepo(dir, root);
	const fj = path.join(dir, "feature.json");
	if (!existsSync(fj)) {
		out.push(
			find("feature-json-missing", "error", scopeId, `Feature ${featureId}: missing feature.json`, {
				path: rel,
				repairable: false,
			}),
		);
		return out;
	}
	try {
		const meta = JSON.parse(readFileSync(fj, "utf8")) as {
			id?: string;
			personas?: string[];
			primaryCommand?: string;
			implementationStatus?: string;
			driver?: string;
		};
		if (meta.id && meta.id !== featureId) {
			out.push(
				find(
					"feature-id-mismatch",
					"warn",
					scopeId,
					`Feature folder ${featureId} != feature.json.id ${meta.id}`,
					{ path: rel, repairable: true, repairAction: "feature-json-id" },
				),
			);
		}
		if (meta.implementationStatus === "stub") {
			out.push(
				find(
					"feature-stub",
					"warn",
					scopeId,
					`Feature ${featureId}: implementationStatus stub — not review-ready`,
					{ path: rel },
				),
			);
		}
		if (
			meta.primaryCommand &&
			/eval:agent/i.test(meta.primaryCommand) &&
			!/eval|live/i.test(featureId)
		) {
			out.push(
				find(
					"feature-primary-keyword-trap",
					"error",
					scopeId,
					`Feature ${featureId}: primaryCommand looks like monorepo keyword trap (${meta.primaryCommand})`,
					{ path: rel, repairable: false },
				),
			);
		} else if (
			meta.primaryCommand &&
			/agent:check/i.test(meta.primaryCommand) &&
			!/agent-check|staged|narrow-local|local-validation/i.test(featureId)
		) {
			out.push(
				find(
					"feature-primary-keyword-trap",
					"error",
					scopeId,
					`Feature ${featureId}: primaryCommand looks like monorepo keyword trap (${meta.primaryCommand})`,
					{ path: rel, repairable: false },
				),
			);
		}
	} catch {
		out.push(
			find("feature-json-invalid", "error", scopeId, `Feature ${featureId}: invalid feature.json`, {
				path: rel,
			}),
		);
	}

	const features = readdirSync(dir).filter((f) => f.endsWith(".feature"));
	if (features.length === 0) {
		out.push(
			find("feature-no-gherkin", "error", scopeId, `Feature ${featureId}: no .feature files`, {
				path: rel,
			}),
		);
	}

	const gq = checkGherkinQuality(dir);
	if (!gq.ok) {
		for (const p of gq.problems) {
			out.push(
				find(
					gq.templateOnly ? "feature-template-only" : "feature-gherkin-quality",
					gq.templateOnly ? "error" : "warn",
					scopeId,
					`Feature ${featureId}: ${p}`,
					{ path: rel },
				),
			);
		}
	}

	const rd = checkRubberduckFile(dir);
	if (!rd.ok) {
		out.push(
			find(
				"feature-rubberduck",
				"error",
				scopeId,
				`Feature ${featureId}: EXPERIENCE.md rubber-duck/adversarial incomplete — ${rd.problems[0]}`,
				{
					path: path.join(rel, "EXPERIENCE.md"),
					repairable: true,
					repairAction: "feature-experience-skeleton",
				},
			),
		);
	}

	for (const req of ["steps/bindings.steps.ts", "steps/implementations.ts", "steps/world.ts"]) {
		if (!existsSync(path.join(dir, req))) {
			out.push(
				find(
					"feature-steps-missing",
					"warn",
					scopeId,
					`Feature ${featureId}: missing ${req}`,
					{ path: rel, repairable: false },
				),
			);
		}
	}
	return out;
}

function auditStructure(
	scope: OptimizexpScope,
	root: string,
): DoctorFinding[] {
	const out: DoctorFinding[] = [];
	const dir = scope.optimizexpDir;
	if (!existsSync(dir)) {
		out.push(
			find(
				"scope-missing",
				scope.global ? "error" : "warn",
				scope.id,
				`Missing .optimizexp at ${relFromRepo(dir, root)}`,
				{ path: relFromRepo(dir, root), repairable: true, repairAction: "ensure-scope" },
			),
		);
		return out;
	}
	const cfg = path.join(dir, "config.json");
	if (!existsSync(cfg)) {
		out.push(
			find("config-missing", "warn", scope.id, "Missing config.json", {
				path: relFromRepo(cfg, root),
				repairable: true,
				repairAction: "ensure-config",
			}),
		);
	} else {
		const loaded = loadConfigFile(cfg);
		if (loaded.problems.some((p) => p.startsWith("fatal:"))) {
			out.push(
				find(
					"config-invalid",
					"error",
					scope.id,
					`config.json invalid: ${loaded.problems.join("; ")}`,
					{ path: relFromRepo(cfg, root) },
				),
			);
		} else if (loaded.problems.length) {
			out.push(
				find(
					"config-warn",
					"warn",
					scope.id,
					`config.json issues: ${loaded.problems.join("; ")}`,
					{ path: relFromRepo(cfg, root) },
				),
			);
		}
	}
	const gi = path.join(dir, ".gitignore");
	if (!existsSync(gi)) {
		out.push(
			find("gitignore-missing", "warn", scope.id, "Missing managed .gitignore", {
				path: relFromRepo(gi, root),
				repairable: true,
				repairAction: "ensure-gitignore",
			}),
		);
	}
	if (scope.global) {
		for (const sub of ["personas", "features", "bus/entries", "runs"]) {
			const p = path.join(dir, sub);
			if (!existsSync(p)) {
				out.push(
					find(
						`dir-missing-${sub.replace("/", "-")}`,
						"warn",
						scope.id,
						`Missing ${sub}/`,
						{ path: relFromRepo(p, root), repairable: true, repairAction: "ensure-dirs" },
					),
				);
			}
		}
	} else {
		for (const sub of ["personas", "features"]) {
			const p = path.join(dir, sub);
			if (!existsSync(p)) {
				out.push(
					find(
						`dir-missing-${sub}`,
						"info",
						scope.id,
						`Missing ${sub}/ (ok if unused)`,
						{ path: relFromRepo(p, root), repairable: true, repairAction: "ensure-dirs" },
					),
				);
			}
		}
	}
	return out;
}

function auditProjectMaps(
	project: ProjectRef,
	root: string,
): DoctorFinding[] {
	const out: DoctorFinding[] = [];
	const map = readSurfaceMap(project, root);
	if (!map) {
		out.push(
			find(
				"surface-map-missing",
				"warn",
				project.id,
				"No surface-map.json — run explore-app or doctor --repair maps",
				{ repairable: true, repairAction: "build-surface-map" },
			),
		);
	} else {
		const problems = validateSurfaceMap(map);
		for (const p of problems) {
			out.push(
				find("surface-map-invalid", "error", project.id, p, {
					repairable: true,
					repairAction: "build-surface-map",
				}),
			);
		}
		if (map.binaries.length === 0) {
			out.push(
				find(
					"no-binaries",
					"info",
					project.id,
					"No package.json bin (library/site/example) — no CLI default-entry required",
				),
			);
		}
		if (map.defaultEntry?.interactive && map.interactiveSurfaces.length === 0) {
			out.push(
				find(
					"interactive-unmapped",
					"error",
					project.id,
					"Interactive default entry but no interactiveSurfaces",
					{ repairable: true, repairAction: "build-surface-map" },
				),
			);
		}
	}
	const catalog = readExperienceCatalog(project, root);
	if (!catalog) {
		out.push(
			find(
				"catalog-missing",
				map?.binaries.length ? "warn" : "info",
				project.id,
				"No experience-catalog.json — feature gen critical path incomplete for CLI products",
				{ repairable: true, repairAction: "build-catalog" },
			),
		);
	} else if (map?.binaries.length) {
		const personas = [
			...new Set(catalog.experiences.map((e) => e.personaId)),
		];
		for (const p of validateCatalogCoverage(catalog, personas)) {
			out.push(find("catalog-coverage", "error", project.id, p));
		}
		if (
			!catalog.experiences.some((e) => e.experienceId.startsWith("cold-start"))
		) {
			out.push(
				find(
					"catalog-no-default-entry",
					"error",
					project.id,
					"Catalog missing cold-start default-entry experiences",
					{ repairable: true, repairAction: "build-catalog" },
				),
			);
		}
	}
	return out;
}

export function runDoctorCheck(input: {
	root?: string;
	selection?: ProjectSelection;
	/** Include feature quality deep scan */
	deepFeatures?: boolean;
}): DoctorReport {
	const root = input.root ?? repoRoot();
	const selection =
		input.selection ??
		resolveProjects("all", root);
	const findings: DoctorFinding[] = [];

	// Global structure
	findings.push(...auditStructure(globalScope(root), root));

	const scopes = scopesForSelection(selection, root);
	for (const scope of scopes) {
		if (scope.global) continue;
		findings.push(...auditStructure(scope, root));
	}

	// Personas
	const personas = listPersonaMetas(root, selection);
	if (personas.length === 0) {
		findings.push(
			find(
				"no-personas",
				"error",
				"global",
				"No personas found in global or selected project scopes",
				{ repairable: false },
			),
		);
	}
	for (const p of personas) {
		findings.push(...auditPersonaFile(p, root));
	}

	// Features — when a single project is selected, deep-scan only that project's
	// features (global legacy scaffolds stay advisory unless --all-projects).
	const features = listFeatures(root, selection);
	const focusProject =
		!selection.allProjects && selection.projects.length === 1
			? selection.projects[0]!.id
			: null;
	const deepFeatures = features.filter((loc) => {
		if (!focusProject) return true;
		return loc.scope.id === focusProject || loc.scope.projectPath.includes(focusProject);
	});
	const advisoryFeatures = features.filter((loc) => !deepFeatures.includes(loc));

	if (deepFeatures.length === 0 && features.length === 0) {
		findings.push(
			find(
				"no-features",
				"warn",
				focusProject ?? "global",
				"No feature folders — run explore + from-catalog before review",
			),
		);
	}
	for (const loc of deepFeatures) {
		if (input.deepFeatures === false) continue;
		findings.push(...auditFeatureDir(loc.id, loc.dir, loc.scope.id, root));
	}
	// Global features when focused on a project: info only (do not fail project doctor)
	if (focusProject && advisoryFeatures.length && input.deepFeatures !== false) {
		findings.push(
			find(
				"global-features-advisory",
				"info",
				"global",
				`${advisoryFeatures.length} global feature folder(s) not deep-scanned (project focus: ${focusProject}). Use --all-projects to include.`,
			),
		);
	}

	// Project maps / catalogs
	const projects = selection.allProjects
		? listProjects(root).filter((p) => p.id !== "root")
		: selection.projects.filter((p) => p.id !== "root");
	for (const p of projects) {
		findings.push(...auditProjectMaps(p, root));
	}

	const errors = findings.filter((f) => f.severity === "error").length;
	const warns = findings.filter((f) => f.severity === "warn").length;
	const infos = findings.filter((f) => f.severity === "info").length;
	const repairable = findings.filter((f) => f.repairable).length;

	return {
		ok: errors === 0,
		scannedAt: new Date().toISOString(),
		root,
		mode: "check",
		findings,
		repairsApplied: [],
		summary: { errors, warns, infos, repairable },
	};
}

function repairPersonaExperiences(filePath: string): void {
	let text = readFileSync(filePath, "utf8");
	if (!/^---/m.test(text)) return;
	if (!/^experiences:/m.test(text.split("---")[1] ?? "")) {
		text = text.replace(
			/^---\r?\n/,
			"---\nexperiences: [dx, ax]\n",
		);
	} else {
		text = text.replace(
			/^experiences:\s*\[[^\]]*\]/m,
			"experiences: [dx, ax]",
		);
		text = text.replace(
			/^experiences:\s*$/m,
			"experiences: [dx, ax]",
		);
	}
	if (!/^schemaVersion:/m.test(text)) {
		text = text.replace(/^---\r?\n/, "---\nschemaVersion: 2\n");
	}
	writeFileSync(filePath, text, "utf8");
}

function repairPersonaV2Stubs(filePath: string): void {
	let text = readFileSync(filePath, "utf8");
	const stubs: [RegExp, string][] = [
		[
			/## Market segment/i,
			`## Market segment

- segmentIds: [product-stakeholder]
- primary job: complete critical path without tribal knowledge
- secondary jobs: report friction with evidence
- non-jobs: unrelated product areas
`,
		],
		[
			/## Demographic model/i,
			`## Demographic model

- roleFamily: stakeholder
- seniority: mid
- orgArchetype: product-team
- domainFamiliarity: intermediate
- localeContext: en-primary
- deviceContext: desktop-first
- timeBudget: minutes
- accessibilityProfile: text-first
`,
		],
		[
			/## Psychographic model/i,
			`## Psychographic model

- values: [clarity, autonomy, safety]
- riskTolerance: medium
- noveltySeeking: medium
- trustInAutomation: medium
- documentationPreference: examples-first
- errorEmotion: frustrated-when-opaque
- socialProofNeed: low
- aestheticSensitivity: medium
- controlNeed: medium
`,
		],
		[
			/## Cognitive thresholds/i,
			`## Cognitive thresholds

- featureSprawl: 3
- visualClutter: 3
- interactiveClutter: 3
- choiceOverload: 3
- informationDensity: 3
- noveltyTax: 3
- contextSwitchTax: 2
- workingMemoryLoad: 2
- interruptionFragility: 2
`,
		],
	];
	for (const [re, block] of stubs) {
		if (!re.test(text)) {
			// insert before ## Review instructions or at end
			if (/## Review instructions/i.test(text)) {
				text = text.replace(/## Review instructions/i, `${block}\n## Review instructions`);
			} else {
				text = `${text.trimEnd()}\n\n${block}`;
			}
		}
	}
	if (!/^segmentIds:/m.test(text.split("---")[1] ?? "")) {
		text = text.replace(/^---\r?\n/, "---\nsegmentIds: [product-stakeholder]\n");
	}
	if (!/^schemaVersion:\s*2/m.test(text)) {
		if (/^schemaVersion:/m.test(text)) {
			text = text.replace(/^schemaVersion:\s*\d+/m, "schemaVersion: 2");
		} else {
			text = text.replace(/^---\r?\n/, "---\nschemaVersion: 2\n");
		}
	}
	writeFileSync(filePath, text, "utf8");
}

function repairFeatureExperienceSkeleton(dir: string, featureId: string): void {
	const p = path.join(dir, "EXPERIENCE.md");
	if (existsSync(p) && checkRubberduckFile(dir).ok) return;
	const seed = existsSync(path.join(dir, "SEED.md"))
		? readFileSync(path.join(dir, "SEED.md"), "utf8").slice(0, 200)
		: featureId;
	const body = `# EXPERIENCE: ${featureId}

- entryCommand: \`${featureId.includes("hobo") ? "hobo --help" : "TODO"}\`
- driver: cli
- intent: ${seed.replace(/\n/g, " ").slice(0, 160)}

## Rubber-duck (explain to a new teammate)

1. Who is the persona and what are they trying to finish in the next 2 minutes?
   - TODO — fill before review
2. What exact command / UI path do they take from a clean machine?
   - TODO
3. What do they see first? (quote expected chrome, not vibes)
   - TODO
4. What would make them think they opened the wrong product?
   - TODO
5. Happy path: step-by-step (Given/When/Then in prose first).
   - TODO
6. Failure path: how do they break it, what must the product say?
   - TODO
7. What evidence will prove a human/agent actually ran this? (driver + command)
   - TODO
8. What is deliberately out of scope for this feature folder?
   - TODO

## Adversarial critique (must check all)

- [ ] Did not skip default entry because a secondary verb is easier to automate
- [ ] Not testing a monorepo script instead of the product binary
- [ ] No When-step is only “exercise the surface” without a real command
- [ ] Scores cannot be invented without reading stdout/TUI
- [ ] Persona vocabulary/asserts considered for shared paths
- [ ] Security: secrets, destructive promote, network—fail-closed
- [ ] Cognitive load: journey stays within persona thresholds
- [ ] Confusion twin: stock UI / wrong binary / wrong verb—covered
- [ ] If this feature were the only one we ship, the persona would not still be lost

## Verdict

- revise
- primaryCommand: TODO
- driver: cli
`;
	writeFileSync(p, body, "utf8");
}

export function runDoctorRepair(input: {
	root?: string;
	selection?: ProjectSelection;
	/** Only apply these repairAction ids when set */
	only?: string[];
}): DoctorReport {
	const root = input.root ?? repoRoot();
	const check = runDoctorCheck({
		root,
		selection: input.selection,
		deepFeatures: true,
	});
	const repairsApplied: string[] = [];
	const only = input.only?.length ? new Set(input.only) : null;

	const apply = (action: string, fn: () => void) => {
		if (only) {
			// Allow --only ensure-config or --only feature-experience (prefix match)
			const hit = [...only].some(
				(o) =>
					action === o ||
					action.startsWith(`${o}:`) ||
					action.startsWith(o) ||
					o.startsWith(action.split(":")[0]!),
			);
			if (!hit) return;
		}
		fn();
		repairsApplied.push(action);
	};

	// Structure repairs
	apply("ensure-config", () => {
		ensureGlobalConfig(root);
		const selection = input.selection ?? resolveProjects("all", root);
		const projects = selection.allProjects
			? listProjects(root)
			: selection.projects;
		for (const p of projects) {
			if (p.id === "root") continue;
			ensureProjectConfig(p, root);
		}
	});
	apply("ensure-gitignore", () => {
		ensureGlobalGitignore(skillBuiltinGitignoreConfig("global"), root);
		const selection = input.selection ?? resolveProjects("all", root);
		const projects = selection.allProjects
			? listProjects(root)
			: selection.projects;
		for (const p of projects) {
			if (p.id === "root") continue;
			ensureProjectGitignore(
				p,
				skillBuiltinGitignoreConfig("project"),
				root,
			);
		}
	});
	apply("ensure-dirs", () => {
		const g = globalOptimizexpRoot(root);
		ensureDir(g);
		ensureGitkeep(path.join(g, "personas"));
		ensureGitkeep(path.join(g, "features"));
		ensureGitkeep(path.join(g, "bus", "entries"));
		ensureGitkeep(path.join(g, "runs"));
		const selection = input.selection ?? resolveProjects("all", root);
		for (const scope of scopesForSelection(selection, root)) {
			if (scope.global) continue;
			ensureDir(scope.optimizexpDir);
			ensureGitkeep(personasDir(scope));
			ensureGitkeep(featuresRoot(scope));
		}
	});
	apply("ensure-scope", () => {
		ensureDir(globalOptimizexpRoot(root));
		ensureGlobalConfig(root);
		ensureGlobalGitignore(skillBuiltinGitignoreConfig("global"), root);
	});

	// Persona repairs
	const personas = listPersonaMetas(root, input.selection);
	for (const p of personas) {
		const needsExp = check.findings.some(
			(f) =>
				f.path === p.relPath &&
				(f.repairAction === "persona-experiences-default" ||
					f.repairAction === "persona-schema-v2"),
		);
		if (needsExp) {
			apply(`persona-experiences:${p.id}`, () => repairPersonaExperiences(p.path));
		}
		const needsV2 = check.findings.some(
			(f) =>
				f.path === p.relPath &&
				(f.repairAction === "persona-v2-sections" ||
					f.repairAction === "persona-segmentIds"),
		);
		if (needsV2) {
			apply(`persona-v2:${p.id}`, () => repairPersonaV2Stubs(p.path));
		}
	}

	// Feature EXPERIENCE skeletons — same project-focus filter as check deep scan
	const allFeatures = listFeatures(root, input.selection);
	const focusProject =
		input.selection &&
		!input.selection.allProjects &&
		input.selection.projects.length === 1
			? input.selection.projects[0]!.id
			: null;
	const features = allFeatures.filter((loc) => {
		if (!focusProject) return true;
		return (
			loc.scope.id === focusProject ||
			loc.scope.projectPath.includes(focusProject)
		);
	});
	for (const loc of features) {
		const needs = check.findings.some(
			(f) =>
				f.repairAction === "feature-experience-skeleton" &&
				(f.path?.includes(loc.id) || f.message.includes(loc.id)),
		);
		if (needs || !existsSync(path.join(loc.dir, "EXPERIENCE.md"))) {
			apply(`feature-experience:${loc.id}`, () =>
				repairFeatureExperienceSkeleton(loc.dir, loc.id),
			);
		}
		// Fix feature.json id mismatch
		const fj = path.join(loc.dir, "feature.json");
		if (existsSync(fj)) {
			try {
				const meta = JSON.parse(readFileSync(fj, "utf8")) as { id?: string };
				if (meta.id && meta.id !== loc.id) {
					apply(`feature-json-id:${loc.id}`, () => {
						meta.id = loc.id;
						writeFileSync(fj, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
					});
				}
			} catch {
				/* ignore */
			}
		}
	}

	// Maps / catalogs
	const selection = input.selection ?? resolveProjects("all", root);
	const projects = selection.allProjects
		? listProjects(root).filter((p) => p.id !== "root")
		: selection.projects.filter((p) => p.id !== "root");
	for (const p of projects) {
		const needMap = check.findings.some(
			(f) => f.scope === p.id && f.repairAction === "build-surface-map",
		);
		if (needMap || !readSurfaceMap(p, root)) {
			apply(`surface-map:${p.id}`, () => {
				const map = buildSurfaceMap({ project: p, root, skipProbes: true });
				writeSurfaceMap(map, p, root);
			});
		}
		const needCat = check.findings.some(
			(f) => f.scope === p.id && f.repairAction === "build-catalog",
		);
		if (needCat || !readExperienceCatalog(p, root)) {
			apply(`catalog:${p.id}`, () => {
				const map = readSurfaceMap(p, root);
				const catalog = buildExperienceCatalog({
					project: p,
					root,
					surfaceMap: map,
				});
				writeExperienceCatalog(catalog, p, root);
			});
		}
	}

	// Re-check after repairs
	const after = runDoctorCheck({
		root,
		selection: input.selection,
		deepFeatures: true,
	});
	return {
		...after,
		mode: "repair",
		repairsApplied: [...new Set(repairsApplied)],
	};
}

/**
 * Safe snapshot of optimizexp workspace state (structure + metadata digests).
 * Does not copy large evidence media by default.
 */
export function runDoctorSnapshot(input: {
	root?: string;
	selection?: ProjectSelection;
	outDir?: string;
}): DoctorReport {
	const root = input.root ?? repoRoot();
	const selection = input.selection ?? resolveProjects("all", root);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir =
		input.outDir ??
		path.join(globalOptimizexpRoot(root), "snapshots", `doctor-${stamp}`);
	ensureDir(outDir);

	const check = runDoctorCheck({ root, selection, deepFeatures: true });
	writeFileSync(
		path.join(outDir, "doctor-report.json"),
		`${JSON.stringify(check, null, 2)}\n`,
		"utf8",
	);

	const manifest: {
		files: { rel: string; sha256: string; bytes: number }[];
		copiedAt: string;
	} = { files: [], copiedAt: new Date().toISOString() };

	const copyIf = (abs: string, rel: string) => {
		if (!existsSync(abs) || !statSync(abs).isFile()) return;
		// skip large media
		if (/\.(mp4|webm|gif|cast|png|jpg)$/i.test(abs)) return;
		const dest = path.join(outDir, "tree", rel);
		ensureDir(path.dirname(dest));
		copyFileSync(abs, dest);
		const buf = readFileSync(abs);
		manifest.files.push({
			rel,
			sha256: createHash("sha256").update(buf).digest("hex"),
			bytes: buf.length,
		});
	};

	// Snapshot key metadata only
	const g = globalOptimizexpRoot(root);
	for (const name of ["config.json", "INIT.md", "init-report.json"]) {
		copyIf(path.join(g, name), path.join(".optimizexp", name));
	}
	// personas + feature.json + EXPERIENCE.md + SEED.md
	for (const scope of scopesForSelection(selection, root)) {
		const baseRel = relFromRepo(scope.optimizexpDir, root);
		copyIf(path.join(scope.optimizexpDir, "config.json"), path.join(baseRel, "config.json"));
		copyIf(path.join(scope.optimizexpDir, "surface-map.json"), path.join(baseRel, "surface-map.json"));
		copyIf(
			path.join(scope.optimizexpDir, "experience-catalog.json"),
			path.join(baseRel, "experience-catalog.json"),
		);
		const pDir = personasDir(scope);
		if (existsSync(pDir)) {
			for (const f of readdirSync(pDir)) {
				if (f.endsWith(".md")) {
					copyIf(path.join(pDir, f), path.join(baseRel, "personas", f));
				}
			}
		}
		const fRoot = featuresRoot(scope);
		if (existsSync(fRoot)) {
			for (const id of readdirSync(fRoot)) {
				const fd = path.join(fRoot, id);
				if (!statSync(fd).isDirectory()) continue;
				for (const name of [
					"feature.json",
					"EXPERIENCE.md",
					"SEED.md",
					"README.md",
				]) {
					copyIf(path.join(fd, name), path.join(baseRel, "features", id, name));
				}
				// small gherkin only
				for (const f of readdirSync(fd)) {
					if (f.endsWith(".feature")) {
						copyIf(path.join(fd, f), path.join(baseRel, "features", id, f));
					}
				}
			}
		}
	}

	writeFileSync(
		path.join(outDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
	writeFileSync(
		path.join(outDir, "README.md"),
		`# OptimizeXP doctor snapshot\n\nCreated: ${manifest.copiedAt}\n\nSafe metadata snapshot (no large evidence media). Restore by copying \`tree/\` paths back carefully.\n`,
		"utf8",
	);

	return {
		...check,
		mode: "snapshot",
		snapshotPath: relFromRepo(outDir, root),
		repairsApplied: [],
	};
}

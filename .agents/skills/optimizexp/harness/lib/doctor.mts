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
} from "./feature-quality.mts";
import {
	readSurfaceMap,
	validateSurfaceMap,
	buildSurfaceMap,
	writeSurfaceMap,
} from "./surface-map.mts";

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
				{ path: meta.relPath, repairable: false },
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
				{ path: meta.relPath, repairable: false },
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
				{ path: meta.relPath, repairable: false },
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
							repairable: false,
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
					{ path: meta.relPath, repairable: false },
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
	for (const name of ["config.json"]) {
		copyIf(path.join(g, name), path.join(".optimizexp", name));
	}
	for (const scope of scopesForSelection(selection, root)) {
		const baseRel = relFromRepo(scope.optimizexpDir, root);
		copyIf(path.join(scope.optimizexpDir, "config.json"), path.join(baseRel, "config.json"));
		copyIf(path.join(scope.optimizexpDir, "surface-map.json"), path.join(baseRel, "surface-map.json"));
		const fRoot = featuresRoot(scope);
		if (existsSync(fRoot)) {
			for (const id of readdirSync(fRoot)) {
				const fd = path.join(fRoot, id);
				if (!statSync(fd).isDirectory()) continue;
				for (const name of ["feature.json"]) {
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

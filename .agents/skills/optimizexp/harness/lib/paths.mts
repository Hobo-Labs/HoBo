import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
	listProjects,
	type ProjectRef,
	type ProjectSelection,
} from "./projects.mts";

/** Global scope id: repo-root `.optimizexp/` (cross-cutting personas/features). */
export const GLOBAL_SCOPE_ID = "global";

/**
 * Repo root discovery.
 * Prefer a directory that has `.git`, else any ancestor with `.optimizexp`,
 * else cwd. Project-local `.optimizexp` folders do **not** redefine the repo root.
 */
export function repoRoot(start = process.cwd()): string {
	let dir = path.resolve(start);
	let foundOptimizexp: string | null = null;
	for (;;) {
		if (existsSync(path.join(dir, ".git"))) return dir;
		if (
			!foundOptimizexp &&
			existsSync(path.join(dir, ".optimizexp"))
		) {
			// Remember but keep walking for .git so monorepo project folders
			// with their own .optimizexp don't pin the "repo root" too deep.
			foundOptimizexp = dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return foundOptimizexp ?? process.cwd();
		}
		dir = parent;
	}
}

/** Absolute path to the **global** (repo-root) `.optimizexp/`. */
export function optimizexpRoot(root = repoRoot()): string {
	return path.join(root, ".optimizexp");
}

/** Alias for clarity in new code. */
export function globalOptimizexpRoot(root = repoRoot()): string {
	return optimizexpRoot(root);
}

export type OptimizexpScope = {
	/** `global` for root `.optimizexp/`, else project id */
	id: string;
	/** Path relative to repo root for the project ("" for global) */
	projectPath: string;
	/** Absolute path to this scope's `.optimizexp/` directory */
	optimizexpDir: string;
	/** true when this is the repo-root global tree */
	global: boolean;
};

/**
 * Resolve the `.optimizexp` directory for a project ref.
 * Root project (`path === ""` / kind root) → **global** root `.optimizexp/`.
 * Other projects → `<projectPath>/.optimizexp/`.
 */
export function scopeForProject(
	project: ProjectRef | { id: string; path: string; kind?: string },
	root = repoRoot(),
): OptimizexpScope {
	const isRoot =
		!project.path ||
		project.path === "." ||
		project.id === "root" ||
		(project as ProjectRef).kind === "root";
	if (isRoot) {
		return {
			id: GLOBAL_SCOPE_ID,
			projectPath: "",
			optimizexpDir: globalOptimizexpRoot(root),
			global: true,
		};
	}
	return {
		id: project.id,
		projectPath: project.path,
		optimizexpDir: path.join(root, project.path, ".optimizexp"),
		global: false,
	};
}

/** Global scope only. */
export function globalScope(root = repoRoot()): OptimizexpScope {
	return {
		id: GLOBAL_SCOPE_ID,
		projectPath: "",
		optimizexpDir: globalOptimizexpRoot(root),
		global: true,
	};
}

/**
 * Scopes to read when evaluating a project selection.
 * Always includes **global**, plus one scope per non-root selected project.
 */
export function scopesForSelection(
	selection: ProjectSelection | undefined,
	root = repoRoot(),
): OptimizexpScope[] {
	const out: OptimizexpScope[] = [globalScope(root)];
	const seen = new Set<string>([GLOBAL_SCOPE_ID]);
	const projects = selection?.allProjects
		? listProjects(root)
		: selection?.projects ?? listProjects(root);
	for (const p of projects) {
		const s = scopeForProject(p, root);
		if (seen.has(s.id)) continue;
		seen.add(s.id);
		out.push(s);
	}
	return out;
}

/**
 * Resolve a write scope from a project selection.
 * - all-projects / multi-project → **global** (shared content)
 * - single non-root project → that project's `.optimizexp/`
 * - single root → global
 */
export function writeScopeFromSelection(
	selection: ProjectSelection,
	root = repoRoot(),
): OptimizexpScope {
	if (selection.allProjects || selection.projects.length !== 1) {
		return globalScope(root);
	}
	return scopeForProject(selection.projects[0]!, root);
}

/** Normalize string arg: OptimizexpScope dir, or legacy repo-root path. */
function asOptimizexpDir(scopeOrRoot: OptimizexpScope | string): string {
	if (typeof scopeOrRoot !== "string") return scopeOrRoot.optimizexpDir;
	// Already an .optimizexp directory
	if (
		scopeOrRoot.endsWith(`${path.sep}.optimizexp`) ||
		scopeOrRoot.endsWith(".optimizexp")
	) {
		return scopeOrRoot;
	}
	// Legacy callers pass repo root
	return path.join(scopeOrRoot, ".optimizexp");
}

export function personasDir(
	scopeOrRoot: OptimizexpScope | string = globalScope(),
): string {
	return path.join(asOptimizexpDir(scopeOrRoot), "personas");
}

/**
 * Features directory.
 * Accepts OptimizexpScope, absolute `.optimizexp` dir, or legacy repo-root path.
 */
export function featuresRoot(
	scopeOrRoot: OptimizexpScope | string = globalScope(),
): string {
	return path.join(asOptimizexpDir(scopeOrRoot), "features");
}

/**
 * Feature folder path (global scope when `root` is repo root — legacy).
 * Prefer `featureDirInScope(id, scope)` for project-local writes.
 */
export function featureDir(featureId: string, root = repoRoot()): string {
	return path.join(featuresRoot(root), featureId);
}

export function featureDirInScope(
	featureId: string,
	scope: OptimizexpScope,
): string {
	return path.join(featuresRoot(scope), featureId);
}

export function evidenceDir(
	featureId: string,
	scenario: string,
	root = repoRoot(),
): string {
	return path.join(featureDir(featureId, root), "evidence", scenario);
}

export function evidenceDirInScope(
	featureId: string,
	scenario: string,
	scope: OptimizexpScope,
): string {
	return path.join(
		featureDirInScope(featureId, scope),
		"evidence",
		scenario,
	);
}

export type FeatureLocation = {
	id: string;
	dir: string;
	scope: OptimizexpScope;
	featureJsonPath: string;
};

/**
 * Find a feature folder by id across global + (optional) project scopes.
 * Search order: preferred project scope (if given) → other project scopes → global.
 * First hit wins.
 */
export function findFeature(
	featureId: string,
	root = repoRoot(),
	opts?: {
		preferredProjectId?: string;
		selection?: ProjectSelection;
	},
): FeatureLocation | null {
	const scopes = scopesForSelection(opts?.selection, root);
	// Preferred first
	if (opts?.preferredProjectId) {
		const pref = scopes.find(
			(s) =>
				s.id === opts.preferredProjectId ||
				(opts.preferredProjectId === "root" && s.global),
		);
		if (pref) {
			const hit = tryFeatureInScope(featureId, pref);
			if (hit) return hit;
		}
	}
	// Non-global first so project-local shadows global when both exist
	for (const s of scopes.filter((x) => !x.global)) {
		const hit = tryFeatureInScope(featureId, s);
		if (hit) return hit;
	}
	const g = tryFeatureInScope(featureId, globalScope(root));
	if (g) return g;
	return null;
}

function tryFeatureInScope(
	featureId: string,
	scope: OptimizexpScope,
): FeatureLocation | null {
	const dir = featureDirInScope(featureId, scope);
	const featureJsonPath = path.join(dir, "feature.json");
	if (existsSync(featureJsonPath)) {
		return { id: featureId, dir, scope, featureJsonPath };
	}
	// Also accept folder without feature.json during scaffold
	if (existsSync(dir)) {
		return { id: featureId, dir, scope, featureJsonPath };
	}
	return null;
}

/** List all feature ids under a single scope. */
export function listFeatureIdsInScope(scope: OptimizexpScope): string[] {
	const base = featuresRoot(scope);
	if (!existsSync(base)) return [];
	const out: string[] = [];
	for (const name of readdirSync(base, { withFileTypes: true })) {
		if (!name.isDirectory()) continue;
		if (existsSync(path.join(base, name.name, "feature.json"))) {
			out.push(name.name);
		}
	}
	return out;
}

/**
 * List features across scopes. Project-local entries shadow global same id
 * when both exist (prefer project).
 */
export function listFeatures(
	root = repoRoot(),
	selection?: ProjectSelection,
): FeatureLocation[] {
	const scopes = scopesForSelection(selection, root);
	const byId = new Map<string, FeatureLocation>();
	// Global first, then project overwrites
	for (const s of scopes) {
		for (const id of listFeatureIdsInScope(s)) {
			const loc = tryFeatureInScope(id, s);
			if (!loc) continue;
			const prev = byId.get(id);
			if (!prev || (prev.scope.global && !s.global)) {
				byId.set(id, loc);
			} else if (!prev.scope.global && s.global) {
				// keep project
			} else {
				byId.set(id, loc);
			}
		}
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Discover every project-local `.optimizexp` that already exists on disk
 * (even if empty of features), for listing / doctor.
 */
export function discoverProjectOptimizexpDirs(
	root = repoRoot(),
): OptimizexpScope[] {
	const out: OptimizexpScope[] = [];
	for (const p of listProjects(root)) {
		const s = scopeForProject(p, root);
		if (s.global) continue;
		if (existsSync(s.optimizexpDir)) out.push(s);
	}
	return out;
}

export function skillHarnessDir(root = repoRoot()): string {
	const agents = path.join(root, ".agents/skills/optimizexp/harness");
	if (existsSync(agents)) return agents;
	return path.join(root, ".claude/skills/optimizexp/harness");
}

/** Relative display path from repo root (posix-ish). */
export function relFromRepo(abs: string, root = repoRoot()): string {
	return path.relative(root, abs).split(path.sep).join("/");
}

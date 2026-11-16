/**
 * Managed .gitignore for OptimizeXP global + project trees.
 *
 * Files:
 *   .optimizexp/.gitignore
 *   <project>/.optimizexp/.gitignore
 *
 * Content between BEGIN/END markers is regenerated from config + skill defaults.
 * Lines outside the managed block are preserved (user freeform rules).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	globalScope,
	repoRoot,
	scopeForProject,
	type OptimizexpScope,
} from "./paths.mts";
import type { ProjectRef } from "./projects.mts";

export type OptimizexpConfigKind = "global" | "project";

export const GITIGNORE_FILENAME = ".gitignore";
export const GITIGNORE_BEGIN = "# BEGIN optimizexp-managed";
export const GITIGNORE_END = "# END optimizexp-managed";

/**
 * Toggleable default ignore categories.
 * true = ignore; false = do not emit that pattern set.
 */
export type OptimizexpGitignoreCategories = {
	/** Session runs (scope, iterations, survey scratch) */
	runs: boolean;
	/** Write-ahead bus entry JSON (keep .gitkeep) */
	busEntries: boolean;
	/** Large media under feature evidence (mp4/webm/gif/cast/frames) */
	evidenceMedia: boolean;
	/** All evidence blobs including primary.txt (aggressive) */
	evidenceAll: boolean;
	/** init-report.json regeneration noise */
	initReport: boolean;
	/** OS / editor junk */
	osJunk: boolean;
};

export type OptimizexpGitignoreConfig = {
	/** Write/maintain .gitignore (default true) */
	enabled: boolean;
	/** Rewrite managed block on ensure-config / init (default true) */
	managed: boolean;
	/** Category toggles (merged with skill defaults) */
	ignore?: Partial<OptimizexpGitignoreCategories>;
	/** Extra gitignore lines (appended inside managed block) */
	extra?: string[];
	/**
	 * Lines to never ignore (emitted as `!pattern` after ignores).
	 * Example: keep a golden primary.mp4 path.
	 */
	negate?: string[];
};

export const DEFAULT_GITIGNORE_CATEGORIES: OptimizexpGitignoreCategories = {
	runs: true,
	busEntries: true,
	evidenceMedia: true,
	evidenceAll: false,
	initReport: false,
	osJunk: true,
};

export function mergeGitignoreConfig(
	base: OptimizexpGitignoreConfig,
	patch?: OptimizexpGitignoreConfig,
): OptimizexpGitignoreConfig {
	if (!patch) return { ...base, ignore: { ...base.ignore }, extra: [...(base.extra ?? [])], negate: [...(base.negate ?? [])] };
	return {
		enabled: patch.enabled ?? base.enabled,
		managed: patch.managed ?? base.managed,
		ignore: { ...base.ignore, ...patch.ignore },
		extra: patch.extra ?? base.extra ?? [],
		negate: patch.negate ?? base.negate ?? [],
	};
}

export function skillBuiltinGitignoreConfig(
	kind: OptimizexpConfigKind,
): OptimizexpGitignoreConfig {
	// Project trees have no bus/runs — only evidence + junk
	if (kind === "project") {
		return {
			enabled: true,
			managed: true,
			ignore: {
				...DEFAULT_GITIGNORE_CATEGORIES,
				runs: false,
				busEntries: false,
				initReport: false,
			},
			extra: [],
			negate: [],
		};
	}
	return {
		enabled: true,
		managed: true,
		ignore: { ...DEFAULT_GITIGNORE_CATEGORIES },
		extra: [],
		negate: [],
	};
}

function categoryPatterns(
	kind: OptimizexpConfigKind,
	cats: OptimizexpGitignoreCategories,
): string[] {
	const lines: string[] = [];

	if (kind === "global" && cats.runs) {
		lines.push(
			"# Session run artifacts (regenerated each optimizexp invocation)",
			"runs/**",
			"!runs/.gitkeep",
		);
	}

	if (kind === "global" && cats.busEntries) {
		lines.push(
			"# Write-ahead bus entries (local agent state)",
			"bus/entries/**",
			"!bus/entries/.gitkeep",
		);
	}

	if (cats.evidenceAll) {
		lines.push(
			"# All feature evidence (aggressive — manifests excluded only if negated)",
			"features/**/evidence/**",
			"!features/**/evidence/**/manifest.json",
			"!features/**/evidence/**/meta.json",
		);
	} else if (cats.evidenceMedia) {
		lines.push(
			"# Large / volatile evidence media (keep transcripts + manifest/meta)",
			"features/**/evidence/**/primary.mp4",
			"features/**/evidence/**/primary.webm",
			"features/**/evidence/**/primary.gif",
			"features/**/evidence/**/primary.mov",
			"features/**/evidence/**/*.cast",
			"features/**/evidence/**/frames/",
			"features/**/evidence/**/_stitch/",
			"features/**/evidence/**/_*.png",
			"features/**/evidence/**/_*.jpg",
		);
	}

	if (kind === "global" && cats.initReport) {
		lines.push("# Generated init report", "init-report.json");
	}

	if (cats.osJunk) {
		lines.push("# OS / editor noise", ".DS_Store", "Thumbs.db", "*~", "*.swp");
	}

	return lines;
}

/**
 * Build managed block body (without BEGIN/END markers).
 */
export function buildManagedGitignoreBody(
	kind: OptimizexpConfigKind,
	gi: OptimizexpGitignoreConfig,
): string {
	const cats: OptimizexpGitignoreCategories = {
		...DEFAULT_GITIGNORE_CATEGORIES,
		...gi.ignore,
	};
	// Project scope never has runs/bus
	if (kind === "project") {
		cats.runs = false;
		cats.busEntries = false;
		cats.initReport = false;
	}

	const lines: string[] = [
		"# Generated by optimizexp harness from config.json → gitignore.",
		"# Edit config gitignore.extra / gitignore.negate, or add rules *outside* this block.",
		"",
	];

	lines.push(...categoryPatterns(kind, cats));

	if (gi.extra?.length) {
		lines.push("", "# config.gitignore.extra");
		for (const e of gi.extra) {
			const t = e.trim();
			if (t) lines.push(t);
		}
	}

	if (gi.negate?.length) {
		lines.push("", "# config.gitignore.negate (force track)");
		for (const n of gi.negate) {
			const t = n.trim().replace(/^!+/, "");
			if (t) lines.push(`!${t}`);
		}
	}

	// Trailing newline handled by caller
	return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function wrapManagedBlock(body: string): string {
	return `${GITIGNORE_BEGIN}\n${body.trimEnd()}\n${GITIGNORE_END}\n`;
}

/**
 * Merge managed block into existing .gitignore, preserving user lines outside markers.
 */
export function mergeGitignoreContent(
	existing: string | null,
	managedBlock: string,
): string {
	const header =
		"# OptimizeXP local ignores — see skill references/config.md § gitignore\n";

	if (!existing || !existing.trim()) {
		return header + "\n" + managedBlock + "\n";
	}

	const begin = existing.indexOf(GITIGNORE_BEGIN);
	const end = existing.indexOf(GITIGNORE_END);

	if (begin >= 0 && end > begin) {
		const before = existing.slice(0, begin).replace(/\s+$/, "");
		const after = existing
			.slice(end + GITIGNORE_END.length)
			.replace(/^\s*\n?/, "");
		const parts = [
			before || header.trimEnd(),
			"",
			managedBlock.trimEnd(),
			"",
			after.trimEnd(),
		].filter((p, i, a) => !(p === "" && a[i - 1] === ""));
		return parts.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
	}

	// No markers: prepend managed block after a short note, keep entire existing as user section
	return (
		header +
		"\n" +
		managedBlock +
		"\n# --- user rules (below was pre-existing content) ---\n" +
		existing.replace(/^\uFEFF/, "").trimEnd() +
		"\n"
	);
}

export function gitignorePathForScope(scope: OptimizexpScope): string {
	return path.join(scope.optimizexpDir, GITIGNORE_FILENAME);
}

export function ensureGitignoreForScope(
	scope: OptimizexpScope,
	gi: OptimizexpGitignoreConfig,
	opts?: { force?: boolean },
): { path: string; written: boolean; reason: string } {
	const filePath = gitignorePathForScope(scope);
	if (!gi.enabled) {
		return { path: filePath, written: false, reason: "gitignore.enabled=false" };
	}

	const kind: OptimizexpConfigKind = scope.global ? "global" : "project";
	const managed = wrapManagedBlock(buildManagedGitignoreBody(kind, gi));
	const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;

	if (!gi.managed && existing) {
		return {
			path: filePath,
			written: false,
			reason: "gitignore.managed=false and file exists",
		};
	}

	const next = mergeGitignoreContent(existing, managed);
	if (existing === next && !opts?.force) {
		return { path: filePath, written: false, reason: "unchanged" };
	}

	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, next, "utf8");
	return { path: filePath, written: true, reason: existing ? "updated" : "created" };
}

export function ensureGlobalGitignore(
	gi: OptimizexpGitignoreConfig,
	root = repoRoot(),
): { path: string; written: boolean; reason: string } {
	return ensureGitignoreForScope(
		globalScope(root),
		mergeGitignoreConfig(skillBuiltinGitignoreConfig("global"), gi),
	);
}

export function ensureProjectGitignore(
	project: ProjectRef,
	gi: OptimizexpGitignoreConfig,
	root = repoRoot(),
): { path: string; written: boolean; reason: string } {
	const scope = scopeForProject(project, root);
	if (scope.global) {
		return ensureGlobalGitignore(gi, root);
	}
	return ensureGitignoreForScope(
		scope,
		mergeGitignoreConfig(skillBuiltinGitignoreConfig("project"), gi),
	);
}

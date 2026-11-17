/**
 * Multi-project registry for OptimizeXP.
 * A "project" is an evaluable product unit (site, CLI app, example, draft MVP, or repo root).
 * Default selection: all-projects.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mts";

export type ProjectKind =
	| "root"
	| "site"
	| "package"
	| "example"
	| "draft-project"
	| "app";

export type ProjectRef = {
	/** Stable slug used in flags: site, hobo, hello-bindle, root, … */
	id: string;
	/** Path relative to repo root ("" for root) */
	path: string;
	kind: ProjectKind;
	label: string;
	/** package.json name when present */
	packageName?: string;
};

const ALL = "all";
const ALL_ALIASES = new Set([
	"all",
	"all-projects",
	"*",
	"every",
	"everything",
]);

function listDirs(abs: string): string[] {
	if (!existsSync(abs)) return [];
	return readdirSync(abs, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith("."))
		.map((d) => d.name);
}

function readPkgName(absDir: string): string | undefined {
	const p = path.join(absDir, "package.json");
	if (!existsSync(p)) return undefined;
	try {
		const j = JSON.parse(readFileSync(p, "utf8")) as { name?: string };
		return j.name;
	} catch {
		return undefined;
	}
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/@/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

/**
 * Discover evaluable projects in a monorepo / multi-product workspace.
 */
export function listProjects(root = repoRoot()): ProjectRef[] {
	const out: ProjectRef[] = [];
	const seen = new Set<string>();

	const add = (p: ProjectRef) => {
		if (seen.has(p.id)) return;
		seen.add(p.id);
		out.push(p);
	};

	// Repo root — always present (DX/AX monorepo surfaces)
	add({
		id: "root",
		path: "",
		kind: "root",
		label: "Repository root",
		packageName: readPkgName(root),
	});

	// Site / marketing / docs app
	if (existsSync(path.join(root, "site"))) {
		add({
			id: "site",
			path: "site",
			kind: "site",
			label: "Public site",
			packageName: readPkgName(path.join(root, "site")),
		});
	}
	for (const app of ["apps/web", "web", "frontend", "docs-site"]) {
		if (existsSync(path.join(root, app))) {
			add({
				id: slugify(path.basename(app)),
				path: app,
				kind: "app",
				label: app,
				packageName: readPkgName(path.join(root, app)),
			});
		}
	}

	// Product-ish packages
	const productPkgs = ["cli", "hobo", "mcp", "broker", "cloud"];
	for (const name of productPkgs) {
		const rel = path.join("packages", name);
		if (existsSync(path.join(root, rel, "package.json"))) {
			add({
				id: name,
				path: rel,
				kind: "package",
				label: `packages/${name}`,
				packageName: readPkgName(path.join(root, rel)),
			});
		}
	}

	// examples/*
	for (const name of listDirs(path.join(root, "examples"))) {
		const rel = path.join("examples", name);
		if (!existsSync(path.join(root, rel, "package.json"))) continue;
		add({
			id: slugify(name),
			path: rel,
			kind: "example",
			label: `example:${name}`,
			packageName: readPkgName(path.join(root, rel)),
		});
	}

	// src/draft/projects/*
	for (const name of listDirs(path.join(root, "src/draft/projects"))) {
		if (name.startsWith("_")) continue;
		const rel = path.join("src/draft/projects", name);
		add({
			id: slugify(name),
			path: rel,
			kind: "draft-project",
			label: `draft-project:${name}`,
			packageName: readPkgName(path.join(root, rel)),
		});
	}

	return out.sort((a, b) => a.id.localeCompare(b.id));
}

export type ProjectSelection = {
	/** True when evaluating every discovered project */
	allProjects: boolean;
	/** Concrete project refs in scope */
	projects: ProjectRef[];
	/** Ids as requested (or ["all"]) */
	requested: string[];
	/** Unknown ids the user asked for */
	unknown: string[];
};

/**
 * Resolve --project / --projects flags.
 * Default: all-projects.
 */
export function resolveProjects(
	raw: string | string[] | undefined,
	root = repoRoot(),
): ProjectSelection {
	const all = listProjects(root);
	const byId = new Map(all.map((p) => [p.id, p]));
	// also allow path and packageName aliases
	for (const p of all) {
		if (p.path) byId.set(p.path, p);
		if (p.packageName) {
			byId.set(p.packageName, p);
			byId.set(slugify(p.packageName), p);
		}
	}

	const tokens = normalizeProjectTokens(raw);
	if (tokens.length === 0 || tokens.every((t) => ALL_ALIASES.has(t))) {
		return {
			allProjects: true,
			projects: all,
			requested: [ALL],
			unknown: [],
		};
	}

	const projects: ProjectRef[] = [];
	const unknown: string[] = [];
	const seen = new Set<string>();
	for (const t of tokens) {
		if (ALL_ALIASES.has(t)) {
			return {
				allProjects: true,
				projects: all,
				requested: [ALL],
				unknown: [],
			};
		}
		const hit = byId.get(t) || byId.get(slugify(t));
		if (!hit) {
			unknown.push(t);
			continue;
		}
		if (!seen.has(hit.id)) {
			seen.add(hit.id);
			projects.push(hit);
		}
	}

	return {
		allProjects: false,
		projects,
		requested: tokens,
		unknown,
	};
}

function normalizeProjectTokens(
	raw: string | string[] | undefined,
): string[] {
	if (raw == null) return [];
	const parts = Array.isArray(raw) ? raw : [raw];
	const out: string[] = [];
	for (const p of parts) {
		for (const t of p.split(/[,\s]+/)) {
			const s = t.trim().toLowerCase();
			if (s) out.push(s);
		}
	}
	return out;
}

/** Whether a feature/persona tagged with `projects` is in selection. */
export function matchesProjectScope(
	tagged: string[] | undefined,
	selection: ProjectSelection,
): boolean {
	if (selection.allProjects) return true;
	if (!tagged || tagged.length === 0) {
		// Untagged = root / repo-wide — include when root selected or all
		return selection.projects.some((p) => p.id === "root" || p.kind === "root");
	}
	if (tagged.includes(ALL) || tagged.includes("all-projects")) return true;
	const selected = new Set(selection.projects.map((p) => p.id));
	return tagged.some((t) => selected.has(t) || selected.has(slugify(t)));
}

export function projectIds(selection: ProjectSelection): string[] {
	if (selection.allProjects) return ["all"];
	return selection.projects.map((p) => p.id);
}

export function absProjectPath(ref: ProjectRef, root = repoRoot()): string {
	return ref.path ? path.join(root, ref.path) : root;
}

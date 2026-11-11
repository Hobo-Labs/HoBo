#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
	detectWorkspaceCycles,
	mergeWorkspaceEdges,
	parseWorkspaceEdge,
	validateBoundaryImports,
	type WorkspaceEdge,
} from "../packages/conformance/src/boundaries.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repoRoot, "packages");

type BoundaryViolationRecord = {
	rule: string;
	from_path: string;
	to_path: string;
	effect: "deny";
};

type WorkspaceSkeletonValidatedEvent = {
	workspace_rev: string;
	edges: Array<{ from_path: string; to_path: string }>;
	violations: BoundaryViolationRecord[];
};

function workspaceRev(): string {
	try {
		return execSync("git rev-parse HEAD", {
			cwd: repoRoot,
			encoding: "utf8",
		}).trim();
	} catch {
		return "unknown";
	}
}

/**
 * The workspace globs from `pnpm-workspace.yaml`, which is the only authority on
 * what a workspace package *is*.
 *
 * This used to be an unbounded recursive walk for any `package.json`, and that
 * was the whole bug. It swept up things that are not workspace packages at all —
 * nested example apps, `packages/hobo/fixtures/deploy/vercel`, the
 * scaffolding templates under `packages/patterns/patterns/*` — and every one of
 * them classified as `unknown`, which makes `parseWorkspaceEdge` **throw**.
 *
 * A throw here is not a failed check, it is *no* check: the process aborted on
 * the first stray file, so the boundary gate reported nothing and passed
 * nothing, and it looked exactly like a gate with no violations to find.
 * Reading the globs means a newly added example cannot silently disable it again.
 */
function workspaceGlobs(): string[] {
	const raw = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
	const globs: string[] = [];
	let inPackages = false;
	for (const line of raw.split("\n")) {
		if (line.startsWith("packages:")) {
			inPackages = true;
			continue;
		}
		if (inPackages) {
			const match = /^\s+-\s+"?([^"\s]+)"?\s*$/u.exec(line);
			if (match?.[1]) {
				globs.push(match[1]);
				continue;
			}
			if (/^\S/u.test(line)) break;
		}
	}
	return globs;
}

/** Expand one workspace glob (only the `*` forms pnpm uses here) into directories. */
function expandGlob(glob: string): string[] {
	const parts = glob.split("/");
	let candidates = [repoRoot];
	for (const part of parts) {
		const next: string[] = [];
		for (const base of candidates) {
			if (part === "*") {
				let names: string[];
				try {
					names = readdirSync(base);
				} catch {
					continue;
				}
				for (const name of names) {
					if (name === "node_modules") continue;
					const full = join(base, name);
					try {
						if (statSync(full).isDirectory()) next.push(full);
					} catch {
						// A dangling symlink is not a package.
					}
				}
				continue;
			}
			const full = join(base, part);
			try {
				if (statSync(full).isDirectory()) next.push(full);
			} catch {
				// Glob names a path that does not exist here; skip it.
			}
		}
		candidates = next;
	}
	return candidates;
}

function listPackageJsonFiles(dir: string): string[] {
	const entries: string[] = [];
	// Scoped to the caller's root (`packages/`) exactly as before. The globs fix
	// *how deep* discovery goes, not *how wide*: widening it to the whole
	// workspace would pull in `src/draft/**`, which the classifier treats as
	// external and would therefore report as outward dependencies.
	const root = relative(repoRoot, dir).replaceAll("\\", "/");
	for (const glob of workspaceGlobs()) {
		if (root && !glob.startsWith(`${root}/`) && glob !== root) continue;
		for (const dir of expandGlob(glob)) {
			const candidate = join(dir, "package.json");
			try {
				if (statSync(candidate).isFile()) entries.push(candidate);
			} catch {
				// A workspace glob can match a directory without a manifest.
			}
		}
	}
	return [...new Set(entries)].sort();
}

function packagePathFromJson(packageJsonPath: string): string {
	return relative(repoRoot, dirname(packageJsonPath)).replaceAll("\\", "/");
}

function hoboNameToPath(
	name: string,
	packageMap: Map<string, string>,
): string | undefined {
	return packageMap.get(name);
}

function collectDeclaredEdges(
	packageJsonPath: string,
	packageMap: Map<string, string>,
): WorkspaceEdge[] {
	// SAFETY: assertion to `.parse(readFileSync(packageJsonPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<strin` is required at this boundary.
	const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};

	const from = packagePathFromJson(packageJsonPath);
	const edges: WorkspaceEdge[] = [];
	// Runtime sections first: a name in both `dependencies` and
	// `devDependencies` is a runtime edge, and must not be softened by the
	// dev-only marker just because the dev section also lists it.
	const runtimeNames = new Set(
		[
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.peerDependencies ?? {}),
		].filter((name) => name.startsWith("@hobo/")),
	);
	const depSections: readonly [Record<string, string> | undefined, boolean][] =
		[
			[pkg.dependencies, false],
			[pkg.peerDependencies, false],
			[pkg.devDependencies, true],
		];

	for (const [section, isDevSection] of depSections) {
		if (!section) {
			continue;
		}

		for (const [name] of Object.entries(section)) {
			if (!name.startsWith("@hobo/")) {
				continue;
			}

			const to = hoboNameToPath(name, packageMap);
			if (!to) {
				continue;
			}

			const dev = isDevSection && !runtimeNames.has(name);
			edges.push(parseWorkspaceEdge(dev ? { from, to, dev } : { from, to }));
		}
	}

	return edges;
}

function collectSourceEdges(
	packageDir: string,
	packageMap: Map<string, string>,
): WorkspaceEdge[] {
	const srcDir = join(packageDir, "src");
	const edges: WorkspaceEdge[] = [];
	const from = relative(repoRoot, packageDir).replaceAll("\\", "/");

	const importPatterns = [
		/from\s+["'](@hobo\/[^"']+)["']/g,
		/import\s+["'](@hobo\/[^"']+)["']/g,
	];

	/**
	 * True when the match started inside a string literal rather than at a real
	 * import statement.
	 *
	 * A remediation message that *quotes* an import — `'import { x } from
	 * "@hobo/adapter-openbao"'` — matches the pattern above exactly as a real
	 * import does, and counting it produces a dependency edge that does not
	 * exist. That was enough to report a cycle between `@hobo/identity` and
	 * `@hobo/adapter-openbao` where neither package imports the other.
	 *
	 * The test is the text on the match's own line, before the match: a real
	 * import statement is preceded there by nothing, by `import { … }`, or by
	 * the `} ` of a multi-line import — never by a quote. A quoted one always
	 * carries the opening quote of the string it lives in.
	 */
	function insideStringLiteral(source: string, index: number): boolean {
		const lineStart = source.lastIndexOf("\n", index) + 1;
		const prefix = source.slice(lineStart, index);
		return /["'`]/u.test(prefix);
	}

	function walk(dir: string): void {
		for (const name of readdirSync(dir)) {
			const fullPath = join(dir, name);
			const stats = statSync(fullPath);

			if (stats.isDirectory()) {
				walk(fullPath);
				continue;
			}

			if (!name.endsWith(".ts")) {
				continue;
			}

			const source = readFileSync(fullPath, "utf8");

			for (const pattern of importPatterns) {
				pattern.lastIndex = 0;
				for (const match of source.matchAll(pattern)) {
					const depName = match[1];
					if (!depName) {
						continue;
					}

					if (insideStringLiteral(source, match.index)) {
						continue;
					}

					const to = hoboNameToPath(depName, packageMap);
					if (!to || to === from) {
						// Self-matches are doc-comment/template-string mentions of a
						// package's own name, not real cross-package imports.
						continue;
					}

					edges.push(parseWorkspaceEdge({ from, to }));
				}
			}
		}
	}

	try {
		walk(srcDir);
	} catch {
		return edges;
	}

	return edges;
}

function classifyViolation(error: string): BoundaryViolationRecord | null {
	const edgeMatch = /: ([^ ]+) -> ([^ ]+)$/.exec(error);
	const from_path = edgeMatch?.[1] ?? "";
	const to_path = edgeMatch?.[2] ?? "";

	if (error.startsWith("core must not import HoBo packages:")) {
		return { rule: "core-imports-hobo", from_path, to_path, effect: "deny" };
	}

	if (error.startsWith("adapters must not import each other:")) {
		return {
			rule: "adapter-imports-adapter",
			from_path,
			to_path,
			effect: "deny",
		};
	}

	if (error.startsWith("adapters may import only core ports:")) {
		return {
			rule: "adapter-imports-non-core",
			from_path,
			to_path,
			effect: "deny",
		};
	}

	if (error.startsWith("dependency points outward:")) {
		return { rule: "outward-dependency", from_path, to_path, effect: "deny" };
	}

	if (error.startsWith("workspace dependency cycle:")) {
		return { rule: "workspace-cycle", from_path, to_path, effect: "deny" };
	}

	if (
		error.startsWith("unknown import source ") ||
		error.startsWith("unknown import target ")
	) {
		const path = error.replace(/^unknown import (source|target) /, "");
		return {
			rule: "unknown-package",
			from_path: path,
			to_path: path,
			effect: "deny",
		};
	}

	return null;
}

function main(): void {
	const packageJsonFiles = listPackageJsonFiles(packagesRoot);
	const packageMap = new Map<string, string>();

	for (const packageJsonPath of packageJsonFiles) {
		// SAFETY: assertion to `eadFileSync(packageJsonPath, "utf8")) as { name?: string; }; if (pkg.` is required at this boundary.
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			name?: string;
		};
		if (pkg.name?.startsWith("@hobo/")) {
			packageMap.set(pkg.name, packagePathFromJson(packageJsonPath));
		}
	}

	const discovered: WorkspaceEdge[] = [];

	for (const packageJsonPath of packageJsonFiles) {
		const packageDir = dirname(packageJsonPath);

		discovered.push(
			...collectDeclaredEdges(packageJsonPath, packageMap),
			...collectSourceEdges(packageDir, packageMap),
		);
	}

	// Deduplication used to be a bare `Map.set` keyed on `from->to`, so the
	// surviving edge — and with it the dev marker the harness exemption keys on
	// — was whichever discovery happened to be spread in last. Merging takes the
	// strictest provenance instead, which makes the outcome independent of the
	// order these two collectors are called in.
	const edges = mergeWorkspaceEdges(discovered);
	const boundaryErrors = validateBoundaryImports(edges).errors;
	const cycleErrors = detectWorkspaceCycles(edges).errors;
	const allErrors = [...boundaryErrors, ...cycleErrors];

	const violations = allErrors
		.map((error) => classifyViolation(error))
		.filter((record): record is BoundaryViolationRecord => record !== null);

	const event: WorkspaceSkeletonValidatedEvent = {
		workspace_rev: workspaceRev(),
		edges: edges.map((edge) => ({ from_path: edge.from, to_path: edge.to })),
		violations,
	};

	console.log(JSON.stringify(event));

	if (allErrors.length > 0) {
		for (const error of allErrors) {
			console.error(error);
		}
		process.exit(1);
	}
}

main();

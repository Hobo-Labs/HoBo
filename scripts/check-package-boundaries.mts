#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type BoundaryViolation,
	databaseDriverOf,
	detectWorkspaceCycles,
	mergeWorkspaceEdges,
	parseWorkspaceEdge,
	validateBoundaryImports,
	type WorkspaceEdge,
} from "../packages/conformance/src/boundaries.ts";
import { importSpecifiersOf } from "./lib/test-import-specifiers.mts";

/**
 * The workspace to check. `--root=<dir>` points the gate at another tree, which
 * is how its own tests show it a workspace that breaks a rule: the real one is
 * clean, and a gate only ever run against a clean tree has not been seen to
 * refuse anything.
 */
const rootArg = process.argv
	.slice(2)
	.find((arg) => arg.startsWith("--root="))
	?.slice("--root=".length);
const repoRoot =
	rootArg === undefined || rootArg === ""
		? join(dirname(fileURLToPath(import.meta.url)), "..")
		: resolve(rootArg);
const packagesRoot = join(repoRoot, "packages");

type WorkspaceSkeletonValidatedEvent = {
	workspace_rev: string;
	edges: Array<{ from_path: string; to_path: string }>;
	/** One record per refusal printed on stderr, in the order they are printed. */
	violations: BoundaryViolation[];
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

/**
 * The package a module specifier belongs to: `@hobo/data-sqlite/engine` is
 * `@hobo/data-sqlite`, `pg/lib/native` is `pg`.
 *
 * The source scan used to look the whole specifier up in the package map, so a
 * subpath import of a workspace package matched nothing and was not an edge.
 */
function packageNameOf(specifier: string): string {
	const parts = specifier.split("/");
	return (
		specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)
	).join("/");
}

/**
 * Where an import lands, as the `to` of an edge: a workspace package's path,
 * or the name of a database driver. Anything else — a relative path, a builtin
 * that is not a driver, a third-party package no rule reads — is not an edge.
 */
function edgeTarget(
	specifier: string,
	packageMap: Map<string, string>,
): string | undefined {
	return (
		packageMap.get(packageNameOf(specifier)) ?? databaseDriverOf(specifier)
	);
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
	const runtimeNames = new Set([
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
	]);
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
			// A declared database driver is an edge like a declared workspace
			// package: shipping `pg` as a dependency is depending on it.
			const to = edgeTarget(name, packageMap);
			if (!to) {
				continue;
			}

			const dev = isDevSection && !runtimeNames.has(name);
			edges.push(parseWorkspaceEdge(dev ? { from, to, dev } : { from, to }));
		}
	}

	return edges;
}

/** Every file under `src/` that can hold an import, not only `*.ts`. */
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

/**
 * The runtime edges of one package: every module its `src/` names.
 *
 * Specifiers are read from the syntax tree, not matched in the text. The text
 * match saw `from "…"` and `import "…"` only, so `await import("…")` and
 * `require("…")` were not edges at all — an orchestrator could load an engine
 * either way and the gate stayed green. It also needed a guess about string
 * literals (a remediation message that quotes an import once invented a
 * dependency cycle), and the guess was "a quote earlier on the line", which a
 * dynamic import written as a later argument — `register("sqlite", () =>
 * import("@hobo/data-sqlite"))` — would have been skipped by.
 *
 * Every sighting is a runtime edge, with no `dev` marker, whatever the
 * manifest says: `mergeWorkspaceEdges` then withdraws a devDependency's
 * test-only claim. That includes a type-only import, as it always has; the
 * layering is about what a package is written against.
 *
 * What is not read: a specifier computed at run time (`import(name)`).
 */
function collectSourceEdges(
	packageDir: string,
	packageMap: Map<string, string>,
): WorkspaceEdge[] {
	const srcDir = join(packageDir, "src");
	const edges: WorkspaceEdge[] = [];
	const from = relative(repoRoot, packageDir).replaceAll("\\", "/");

	function walk(dir: string): void {
		for (const name of readdirSync(dir)) {
			const fullPath = join(dir, name);
			const stats = statSync(fullPath, { throwIfNoEntry: false });

			if (stats === undefined) {
				// A dangling symlink holds no source.
				continue;
			}

			if (stats.isDirectory()) {
				walk(fullPath);
				continue;
			}

			if (!SOURCE_FILE.test(name)) {
				continue;
			}

			const source = readFileSync(fullPath, "utf8");

			for (const { specifier } of importSpecifiersOf(source, name)) {
				const to = edgeTarget(specifier, packageMap);
				if (!to || to === from) {
					// A package naming itself is not a cross-package import.
					continue;
				}

				edges.push(parseWorkspaceEdge({ from, to }));
			}
		}
	}

	// Only a package with no `src/` is skipped. This was a `try`/`catch` around
	// the whole walk, which also swallowed the throw `parseWorkspaceEdge` raises
	// for an unclassified import target — and with it every file of the package
	// the walk had not reached yet, so one such import hid all the others.
	if (statSync(srcDir, { throwIfNoEntry: false })?.isDirectory() === true) {
		walk(srcDir);
	}

	return edges;
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
	// The rules name each refusal as they raise it. The event used to be built
	// by matching the printed text against the rules this script knew of, and a
	// refusal it did not recognise — every engine-neutrality one — was printed
	// below and left out of `violations`.
	const boundary = validateBoundaryImports(edges);
	const cycles = detectWorkspaceCycles(edges);
	const allErrors = [...boundary.errors, ...cycles.errors];
	const violations = [...boundary.violations, ...cycles.violations];

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

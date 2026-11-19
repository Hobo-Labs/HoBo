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
					}
				}
				continue;
			}
			const full = join(base, part);
			try {
				if (statSync(full).isDirectory()) next.push(full);
			} catch {
			}
		}
		candidates = next;
	}
	return candidates;
}

function listPackageJsonFiles(dir: string): string[] {
	const entries: string[] = [];
	const root = relative(repoRoot, dir).replaceAll("\\", "/");
	for (const glob of workspaceGlobs()) {
		if (root && !glob.startsWith(`${root}/`) && glob !== root) continue;
		for (const dir of expandGlob(glob)) {
			const candidate = join(dir, "package.json");
			try {
				if (statSync(candidate).isFile()) entries.push(candidate);
			} catch {
			}
		}
	}
	return [...new Set(entries)].sort();
}

function packagePathFromJson(packageJsonPath: string): string {
	return relative(repoRoot, dirname(packageJsonPath)).replaceAll("\\", "/");
}

function packageNameOf(specifier: string): string {
	const parts = specifier.split("/");
	return (
		specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)
	).join("/");
}

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
	const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};

	const from = packagePathFromJson(packageJsonPath);
	const edges: WorkspaceEdge[] = [];
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

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

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
					continue;
				}

				edges.push(parseWorkspaceEdge({ from, to }));
			}
		}
	}

	if (statSync(srcDir, { throwIfNoEntry: false })?.isDirectory() === true) {
		walk(srcDir);
	}

	return edges;
}

function main(): void {
	const packageJsonFiles = listPackageJsonFiles(packagesRoot);
	const packageMap = new Map<string, string>();

	for (const packageJsonPath of packageJsonFiles) {
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

	const edges = mergeWorkspaceEdges(discovered);
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

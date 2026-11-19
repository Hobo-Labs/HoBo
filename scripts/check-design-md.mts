import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonMode = process.argv.includes("--json");

export const WEB_UI_ROOTS = ["site"] as const;

export const WEB_FRAMEWORK_DEPS = new Set([
	"astro",
	"next",
	"nuxt",
	"@sveltejs/kit",
	"@remix-run/react",
	"gatsby",
	"vitepress",
	"@docusaurus/core",
]);

const SKIP_NAMES = new Set([
	"node_modules",
	"dist",
	"build",
	".git",
	"coverage",
	".turbo",
]);

type PackageJson = {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	hobo?: { webUi?: boolean };
};

function isDir(path: string) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readPackageJson(dir: string): PackageJson | null {
	const path = join(dir, "package.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
	} catch {
		return null;
	}
}

function depsOf(pkg: PackageJson): Set<string> {
	return new Set([
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.devDependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
	]);
}

export function hasWebFramework(pkg: PackageJson): boolean {
	const deps = depsOf(pkg);
	for (const name of WEB_FRAMEWORK_DEPS) {
		if (deps.has(name)) return true;
	}
	return false;
}

export function isWebUiProject(
	dir: string,
	pkg: PackageJson | null,
	repoRoot = root,
): boolean {
	const rel = relative(repoRoot, dir).replaceAll("\\", "/") || ".";
	if ((WEB_UI_ROOTS as readonly string[]).includes(rel)) return true;
	if (existsSync(join(dir, "DESIGN.md"))) return true;
	if (pkg?.hobo?.webUi === true) return true;
	if (pkg && hasWebFramework(pkg)) return true;
	return false;
}

export function discoverPackageDirs(repoRoot = root): string[] {
	const out: string[] = [];

	function consider(dir: string) {
		if (!isDir(dir)) return;
		if (existsSync(join(dir, "package.json"))) out.push(dir);
	}

	consider(join(repoRoot, "site"));

	function walkPackages(dir: string, depth: number) {
		if (!isDir(dir) || depth > 6) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (SKIP_NAMES.has(name) || name.startsWith(".")) continue;
			const child = join(dir, name);
			if (!isDir(child)) continue;
			if (existsSync(join(child, "package.json"))) {
				out.push(child);
			}
			walkPackages(child, depth + 1);
		}
	}

	for (const seed of ["packages", "examples", "apps"]) {
		walkPackages(join(repoRoot, seed), 0);
	}

	return [...new Set(out)];
}

export type DesignMdProject = {
	dir: string;
	rel: string;
	designMd: string | null;
	reason: string;
};

export function listWebUiProjects(repoRoot = root): DesignMdProject[] {
	const projects: DesignMdProject[] = [];
	const seen = new Set<string>();

	const candidates = new Set<string>([
		...WEB_UI_ROOTS.map((rel) => join(repoRoot, rel)),
		...discoverPackageDirs(repoRoot),
	]);

	function walkDesignFiles(dir: string, depth: number) {
		if (!isDir(dir) || depth > 6) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (SKIP_NAMES.has(name) || name.startsWith(".")) continue;
			const child = join(dir, name);
			if (name === "DESIGN.md" && !isDir(child)) {
				candidates.add(dirname(child));
			} else if (isDir(child)) {
				walkDesignFiles(child, depth + 1);
			}
		}
	}
	walkDesignFiles(repoRoot, 0);

	for (const dir of candidates) {
		if (!isDir(dir)) continue;
		const rel = relative(repoRoot, dir).replaceAll("\\", "/") || ".";
		if (seen.has(rel)) continue;
		if (
			rel.startsWith("docs/") ||
			rel.startsWith("scripts/") ||
			rel.startsWith("node_modules/")
		)
			continue;

		const pkg = readPackageJson(dir);
		if (!isWebUiProject(dir, pkg, repoRoot)) continue;

		seen.add(rel);
		const hasDesign = existsSync(join(dir, "DESIGN.md"));
		let reason = "DESIGN.md present";
		if ((WEB_UI_ROOTS as readonly string[]).includes(rel))
			reason = "web-ui root";
		else if (pkg?.hobo?.webUi) reason = "hobo.webUi";
		else if (pkg && hasWebFramework(pkg)) reason = "web framework dependency";

		projects.push({
			dir,
			rel,
			designMd: hasDesign ? join(dir, "DESIGN.md") : null,
			reason,
		});
	}

	return projects.sort((a, b) => a.rel.localeCompare(b.rel));
}

type DesignmdInvocation = {
	command: string;
	prefixArgs: string[];
};

function resolveDesignmdInvocation(): DesignmdInvocation {
	const bin = join(root, "node_modules", ".bin", "designmd");
	const siteBin = join(root, "site", "node_modules", ".bin", "designmd");
	const jsEntry = join(
		root,
		"node_modules",
		"@google",
		"design.md",
		"dist",
		"index.js",
	);
	const siteJs = join(
		root,
		"site",
		"node_modules",
		"@google",
		"design.md",
		"dist",
		"index.js",
	);

	if (existsSync(bin)) return { command: bin, prefixArgs: [] };
	if (existsSync(siteBin)) return { command: siteBin, prefixArgs: [] };
	if (existsSync(jsEntry))
		return { command: process.execPath, prefixArgs: [jsEntry] };
	if (existsSync(siteJs))
		return { command: process.execPath, prefixArgs: [siteJs] };
	return { command: "designmd", prefixArgs: [] };
}

export type LintResult = {
	rel: string;
	ok: boolean;
	missing?: boolean;
	stdout: string;
	stderr: string;
	status: number;
};

export function lintDesignMdFile(designMdPath: string): LintResult {
	const rel = relative(root, designMdPath).replaceAll("\\", "/");
	const { command, prefixArgs } = resolveDesignmdInvocation();
	const result = spawnSync(command, [...prefixArgs, "lint", designMdPath], {
		encoding: "utf8",
		cwd: root,
		env: process.env,
	});
	const status = result.status ?? 1;
	return {
		rel,
		ok: status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status,
	};
}

type DesignMdCheckRun = {
	ok: boolean;
	results: LintResult[];
	projects: DesignMdProject[];
};

export function runDesignMdCheck(repoRoot = root): DesignMdCheckRun {
	const projects = listWebUiProjects(repoRoot);
	const results: LintResult[] = [];
	let ok = true;

	for (const project of projects) {
		if (!project.designMd) {
			ok = false;
			results.push({
				rel: `${project.rel}/DESIGN.md`,
				ok: false,
				missing: true,
				stdout: "",
				stderr: `web UI project "${project.rel}" (${project.reason}) is missing DESIGN.md — add one (start from site/DESIGN.md) so agents share one visual contract.`,
				status: 1,
			});
			continue;
		}
		if (repoRoot !== root) {
			results.push({
				rel: relative(repoRoot, project.designMd).replaceAll("\\", "/"),
				ok: true,
				stdout: "",
				stderr: "",
				status: 0,
			});
			continue;
		}
		const linted = lintDesignMdFile(project.designMd);
		if (!linted.ok) ok = false;
		results.push(linted);
	}

	return { ok, results, projects };
}

function main() {
	const { ok, results, projects } = runDesignMdCheck();

	if (jsonMode) {
		console.log(JSON.stringify({ ok, projects, results }, null, 2));
		process.exit(ok ? 0 : 1);
	}

	console.log(
		`design-md: ${projects.length} web UI project(s) — linting with designmd`,
	);
	for (const project of projects) {
		console.log(`  - ${project.rel} (${project.reason})`);
	}

	for (const result of results) {
		if (result.missing) {
			console.error(`\n✖ missing ${result.rel}`);
			console.error(`  ${result.stderr}`);
			continue;
		}
		if (result.ok) {
			console.log(`\n✔ ${result.rel}`);
			const info = result.stdout.trim();
			if (info) {
				try {
					const parsed = JSON.parse(info) as {
						summary?: { errors?: number; warnings?: number };
					};
					const s = parsed.summary;
					if (s)
						console.log(
							`  errors=${s.errors ?? 0} warnings=${s.warnings ?? 0}`,
						);
				} catch {
				}
			}
		} else {
			console.error(`\n✖ ${result.rel} (exit ${result.status})`);
			if (result.stdout) console.error(result.stdout);
			if (result.stderr) console.error(result.stderr);
		}
	}

	if (!ok) {
		console.error(
			"\ndesign-md check failed. Fix DESIGN.md findings or install @google/design.md.",
		);
		process.exit(1);
	}
	console.log("\ndesign-md check ok");
}

const thisFile = fileURLToPath(import.meta.url);
const invoked =
	process.argv[1] !== undefined
		? pathToFileURL(resolve(process.argv[1]!)).href
		: "";
if (invoked === pathToFileURL(thisFile).href) {
	main();
}

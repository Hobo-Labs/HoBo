import { readdirSync, statSync } from "node:fs";
import { posix } from "node:path";
import process from "node:process";
import { readStdin } from "../lib/read-stdin.mts";
import { affectedLanes } from "./affected-lanes.mts";
import {
	CI_INPUTS,
	CODE,
	candidates,
	diskTree,
	literalSpecifiers,
	packageName,
	type Tree,
	type Workspace,
} from "./job-scope.mts";

export type StateMachineScope = Readonly<{ needed: boolean; reason: string }>;

export type SkillTree = Tree &
	Readonly<{
		list: (dir: string) => readonly string[];
		isDir: (path: string) => boolean;
	}>;

export const SKILLS_DIR = ".agents/skills";
export const SKILL_PREFIX = /^\.agents\/skills\/verify-[^/]+\//;

export const BUILT_PACKAGES: readonly string[] = [
	"@hobo/hobo",
	"@hobo/dispatcher",
	"@hobo/ci",
	"@hobo/cd",
	"@hobo/identity",
	"@hobo/storage-sqlite",
	"@hobo/runtime",
];

export const DRIVERS: readonly string[] = [
	"scripts/verify-all-state-machines.sh",
	"scripts/verify-state-machine.sh",
	"scripts/ci/state-machine-scope.mts",
	"scripts/ci/deps-layer.mts",
	"scripts/ci/pnpm-install.mts",
	"scripts/ensure-ts-autocode-links.mts",
];

export const WORKFLOW_INPUTS: readonly RegExp[] = [
	/^\.github\/workflows\/hobo-ci\.yml$/,
	/^\.github\/workflows\/actions\.lock$/,
	/^\.github\/actions\//,
	/^\.github\/action-pins\.env$/,
	...CI_INPUTS.filter(
		(pattern) => !pattern.test(".github/workflows/unrelated.yml"),
	),
];

export const ROOT_INPUTS: readonly RegExp[] = [
	/^package\.json$/,
	/^pnpm-lock\.yaml$/,
	/^pnpm-workspace\.yaml$/,
	/^turbo\.json$/,
	/^mise\.toml$/,
	/^mise\.lock$/,
	/^\.npmrc$/,
	/^\.node-version$/,
	/^tsconfig[^/]*\.json$/,
];

const MENTIONED_PATH =
	/(?:^|[^\w.@-])((?:packages|scripts|src|tools|external|examples|vendor)\/[\w.@/{},*-]*)/g;
const MENTIONED_ROOT_FILE = /["'`]([\w-][\w.-]*\.[\w]+)["'`]/g;
const SHELL = /\.(?:sh|bash)$/;
const MENTIONED_PACKAGE = /@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/g;

export type Reached = Readonly<{
	files: ReadonlySet<string>;
	dirs: ReadonlySet<string>;
	packages: ReadonlySet<string>;
}>;

export function stateMachineReach(
	tree: SkillTree,
): Reached | { unscoped: string } {
	const byName = new Map(tree.workspaces.map((ws) => [ws.name, ws]));
	const byDepth = [...tree.workspaces].sort(
		(a, b) => b.dir.length - a.dir.length,
	);
	const ownerOf = (path: string) =>
		byDepth.find((ws) => path === ws.dir || path.startsWith(`${ws.dir}/`));
	const files = new Set<string>();
	const dirs = new Set<string>();
	const packages = new Set<string>();
	const addPackage = (ws: Workspace) => {
		if (packages.has(ws.dir)) return;
		packages.add(ws.dir);
		for (const dependency of ws.dependencies) {
			const next = byName.get(dependency);
			if (next) addPackage(next);
		}
	};
	for (const name of BUILT_PACKAGES) {
		const ws = byName.get(name);
		if (!ws)
			return { unscoped: `built package ${name} is not in the workspace` };
		addPackage(ws);
	}
	const skillFiles = tree
		.list(SKILLS_DIR)
		.filter((path) => SKILL_PREFIX.test(path));
	if (skillFiles.length === 0)
		return { unscoped: `no verification skill under ${SKILLS_DIR}` };
	const queue = [...DRIVERS, ...skillFiles];
	const seen = new Set<string>();
	const unresolved: string[] = [];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		if (seen.has(file)) continue;
		seen.add(file);
		const owner = ownerOf(file);
		if (owner) {
			addPackage(owner);
			continue;
		}
		files.add(file);
		const source = tree.read(file);
		if (source === undefined) return { unscoped: `cannot read ${file}` };
		if (CODE.test(file))
			for (const specifier of literalSpecifiers(
				withoutLeadingComments(source),
			)) {
				if (!specifier.startsWith(".")) {
					const ws = byName.get(packageName(specifier));
					if (ws) addPackage(ws);
					continue;
				}
				const base = posix
					.normalize(posix.join(posix.dirname(file), specifier))
					.replace(/\/+$/u, "");
				if (base.startsWith("../"))
					return { unscoped: `${file} imports outside the repository` };
				const target = candidates(base).find((path) => tree.isFile(path));
				if (target) queue.push(target);
				else if (base !== "." && tree.isDir(base)) dirs.add(base);
				else if (base !== ".")
					return { unscoped: `cannot resolve ${specifier} from ${file}` };
			}
		for (const match of source.matchAll(MENTIONED_PACKAGE)) {
			const ws = byName.get(match[0]);
			if (ws) addPackage(ws);
		}
		if (!SKILL_PREFIX.test(file) && !SHELL.test(file)) continue;
		for (const match of source.matchAll(MENTIONED_PATH)) {
			const mention = (match[1] ?? "")
				.split(/[{},*]/u)[0]
				?.replace(/[/.]+$/u, "");
			if (!mention || mention.split("/").includes("..")) continue;
			const ws = ownerOf(mention);
			if (ws) {
				addPackage(ws);
				continue;
			}
			if (tree.isFile(mention)) queue.push(mention);
			else if (tree.isDir(mention)) dirs.add(mention);
			else unresolved.push(mention);
		}
		for (const match of source.matchAll(MENTIONED_ROOT_FILE)) {
			const name = match[1] ?? "";
			if (tree.isFile(name)) files.add(name);
		}
	}
	for (const mention of unresolved) {
		const inPackage = [...packages].some((dir) =>
			existingAncestor(`${dir}/${mention}`, tree).startsWith(`${dir}/`),
		);
		if (!inPackage) dirs.add(existingAncestor(mention, tree));
	}
	return { files, dirs, packages };
}

function withoutLeadingComments(source: string): string {
	return source
		.replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gmu, "")
		.replace(/^[ \t]*\/\/.*$/gmu, "");
}

function existingAncestor(path: string, tree: SkillTree): string {
	const segments = path.split("/");
	for (let length = segments.length; length > 1; length -= 1) {
		const ancestor = segments.slice(0, length).join("/");
		if (tree.isDir(ancestor)) return ancestor;
	}
	return segments[0] ?? path;
}

export function stateMachineScope(
	changedPaths: readonly string[],
	tree: SkillTree,
): StateMachineScope {
	const changed = changedPaths
		.map((path) => path.trim())
		.filter((path) => path !== "");
	if (changed.length === 0)
		return { needed: true, reason: "empty diff (base unresolved?)" };
	const skill = changed.find((path) => SKILL_PREFIX.test(path));
	if (skill)
		return { needed: true, reason: `verification skill changed: ${skill}` };
	const input = changed.find((path) =>
		[...WORKFLOW_INPUTS, ...ROOT_INPUTS].some((pattern) => pattern.test(path)),
	);
	if (input)
		return {
			needed: true,
			reason: `workflow, pin or root input changed: ${input}`,
		};
	const outside = changed.filter(
		(path) => !tree.workspaces.some((ws) => path.startsWith(`${ws.dir}/`)),
	);
	const lanes = affectedLanes(outside, tree.isFile);
	if (outside.length > 0 && lanes.mode === "all")
		return { needed: true, reason: lanes.reason };
	const reached = stateMachineReach(tree);
	if ("unscoped" in reached) return { needed: true, reason: reached.unscoped };
	const within = (dirs: ReadonlySet<string>, path: string) =>
		[...dirs].some((dir) => path.startsWith(`${dir}/`));
	const hit = changed.find(
		(path) =>
			reached.files.has(path) ||
			within(reached.dirs, path) ||
			within(reached.packages, path),
	);
	if (hit)
		return {
			needed: true,
			reason: `${hit} is exercised by the verification skills`,
		};
	return {
		needed: false,
		reason: `no changed path reaches the verification skills (${reached.packages.size} package(s), ${reached.files.size} file(s), ${reached.dirs.size} directory(ies))`,
	};
}

function listFiles(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = posix.join(dir, entry.name);
			if (entry.isDirectory()) return listFiles(path);
			return entry.isFile() ? [path] : [];
		});
	} catch {
		return [];
	}
}

export function diskSkillTree(): SkillTree {
	return {
		...diskTree(),
		list: listFiles,
		isDir: (path) => {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		},
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const scope = stateMachineScope(readStdin().split("\n"), diskSkillTree());
	console.error(
		`state-machine-scope: ${scope.needed ? "verify" : "skip"} (${scope.reason})`,
	);
	process.stdout.write(`${scope.needed}\n`);
}

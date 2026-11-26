#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SHADOW_PLAN_PATH, SHADOW_WORKFLOW_PATH } from "./attestation.mts";
import {
	CATALOG_PATH,
	collectCodes,
	isCatalogSource,
	readSources,
	renderCatalog,
} from "./error-catalog.mts";

export const PINS_PATH = "scripts/ci/attestation.mts";
export const NESTED_MERGE = "HOBO_MERGE_DRIVER_NESTED";

const PIN_LINES = {
	[SHADOW_WORKFLOW_PATH]:
		/^(export const SHADOW_WORKFLOW_BLOB = ")([0-9a-f]{40})(";)$/mu,
	[SHADOW_PLAN_PATH]:
		/^(export const SHADOW_PLAN_BLOB = ")([0-9a-f]{40})(";)$/mu,
} as const;

type PinnedPath = keyof typeof PIN_LINES;
const PINNED_PATHS: readonly PinnedPath[] = [
	SHADOW_WORKFLOW_PATH,
	SHADOW_PLAN_PATH,
];

export type Pins = Readonly<Record<PinnedPath, string>>;

type Git = Readonly<{ status: number; stdout: string; stderr: string }>;

function git(
	cwd: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): Git {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env,
		maxBuffer: 1024 * 1024 * 1024,
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export function readPins(text: string): Pins | undefined {
	const workflow = PIN_LINES[SHADOW_WORKFLOW_PATH].exec(text)?.[2];
	const plan = PIN_LINES[SHADOW_PLAN_PATH].exec(text)?.[2];
	if (workflow === undefined || plan === undefined) return undefined;
	return { [SHADOW_WORKFLOW_PATH]: workflow, [SHADOW_PLAN_PATH]: plan };
}

export function writePins(text: string, pins: Pins): string {
	return PINNED_PATHS.reduce(
		(current, path) =>
			current.replace(
				PIN_LINES[path],
				(_line, head: string, _old: string, tail: string) =>
					`${head}${pins[path]}${tail}`,
			),
		text,
	);
}

function theirsFromEnvironment(env: NodeJS.ProcessEnv): string | undefined {
	const heads = Object.keys(env)
		.map((name) => /^GITHEAD_([0-9a-f]{40,64})$/u.exec(name)?.[1])
		.filter((sha) => sha !== undefined);
	return heads.length === 1 ? heads[0] : undefined;
}

type MergedTree = Readonly<{ tree: string; conflicted: ReadonlySet<string> }>;

function mergedTree(cwd: string, theirs: string): MergedTree | undefined {
	const merged = git(
		cwd,
		[
			"merge-tree",
			"--write-tree",
			"--name-only",
			"--no-messages",
			"HEAD",
			theirs,
		],
		{ ...process.env, [NESTED_MERGE]: "1" },
	);
	if (merged.status !== 0 && merged.status !== 1) return undefined;
	const [tree, ...conflicted] = merged.stdout.split("\n");
	if (tree === undefined || !/^[0-9a-f]{40,64}$/u.test(tree)) return undefined;
	return {
		tree,
		conflicted: new Set(conflicted.filter((line) => line !== "")),
	};
}

function blobAt(cwd: string, tree: string, path: string): string | undefined {
	const blob = git(cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${tree}:${path}`,
	]);
	return blob.status === 0 ? blob.stdout.trim() : undefined;
}

export function pinsOfTree(cwd: string, merged: MergedTree): Pins | undefined {
	if (PINNED_PATHS.some((path) => merged.conflicted.has(path)))
		return undefined;
	const workflow = blobAt(cwd, merged.tree, SHADOW_WORKFLOW_PATH);
	const plan = blobAt(cwd, merged.tree, SHADOW_PLAN_PATH);
	if (workflow === undefined || plan === undefined) return undefined;
	return { [SHADOW_WORKFLOW_PATH]: workflow, [SHADOW_PLAN_PATH]: plan };
}

export function pinsOfWorktree(cwd: string): Pins | undefined {
	const hashed = git(cwd, ["hash-object", "--", ...PINNED_PATHS]);
	const [workflow, plan] = hashed.stdout.trim().split("\n");
	if (hashed.status !== 0 || workflow === undefined || plan === undefined)
		return undefined;
	return { [SHADOW_WORKFLOW_PATH]: workflow, [SHADOW_PLAN_PATH]: plan };
}

export function catalogOfTree(
	cwd: string,
	merged: MergedTree,
): string | undefined {
	if ([...merged.conflicted].some(isCatalogSource)) return undefined;
	const listed = git(cwd, [
		"ls-tree",
		"-r",
		"-z",
		"--full-tree",
		merged.tree,
		"--",
		"packages",
	]);
	if (listed.status !== 0) return undefined;
	const blobs = listed.stdout
		.split("\0")
		.map((line) => /^\d+ blob ([0-9a-f]+)\t(.+)$/su.exec(line))
		.filter((match) => match !== null)
		.map((match) => ({ blob: match[1] ?? "", path: match[2] ?? "" }))
		.filter(({ path }) => isCatalogSource(path));
	const batch = spawnSync("git", ["cat-file", "--batch"], {
		cwd,
		input: blobs.map(({ blob }) => blob).join("\n"),
		maxBuffer: 1024 * 1024 * 1024,
	});
	if (batch.status !== 0) return undefined;
	const sources = new Map<string, string>();
	const output = batch.stdout;
	let offset = 0;
	for (const { path } of blobs) {
		const headerEnd = output.indexOf(0x0a, offset);
		const size = Number(
			output.subarray(offset, headerEnd).toString("utf8").split(" ")[2],
		);
		const text = output
			.subarray(headerEnd + 1, headerEnd + 1 + size)
			.toString("utf8");
		offset = headerEnd + 1 + size + 1;
		if (text.includes("HOBO_CI_")) sources.set(path, text);
	}
	return renderCatalog(collectCodes(sources));
}

function mergeFile(
	cwd: string,
	ours: string,
	base: string,
	theirs: string,
): number {
	return git(cwd, [
		"merge-file",
		"-L",
		"ours",
		"-L",
		"base",
		"-L",
		"theirs",
		ours,
		base,
		theirs,
	]).status;
}

function unresolved(path: string, why: string): number {
	process.stderr.write(
		`merge-driver: ${path} ${why}. Resolve the other conflicts, then run: node --experimental-strip-types --no-warnings scripts/ci/merge-driver.mts refresh\n`,
	);
	return 1;
}

export function mergePins(
	cwd: string,
	files: Readonly<{ base: string; ours: string; theirs: string }>,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const ours = readFileSync(files.ours, "utf8");
	const pins = readPins(ours);
	if (pins === undefined)
		return mergeFile(cwd, files.ours, files.base, files.theirs);
	for (const path of [files.base, files.theirs])
		writeFileSync(path, writePins(readFileSync(path, "utf8"), pins));
	if (mergeFile(cwd, files.ours, files.base, files.theirs) !== 0)
		return unresolved(PINS_PATH, "has conflicting changes besides its pins");
	if (env[NESTED_MERGE] !== undefined) return 0;
	const theirs = theirsFromEnvironment(env);
	if (theirs === undefined)
		return unresolved(PINS_PATH, "was merged outside `git merge`");
	const merged = mergedTree(cwd, theirs);
	const next = merged === undefined ? undefined : pinsOfTree(cwd, merged);
	if (next === undefined)
		return unresolved(PINS_PATH, "pins a workflow or plan that conflicts");
	writeFileSync(files.ours, writePins(readFileSync(files.ours, "utf8"), next));
	return 0;
}

export function mergeCatalog(
	cwd: string,
	files: Readonly<{ ours: string }>,
	env: NodeJS.ProcessEnv = process.env,
): number {
	if (env[NESTED_MERGE] !== undefined) return 0;
	const theirs = theirsFromEnvironment(env);
	if (theirs === undefined)
		return unresolved(CATALOG_PATH, "was merged outside `git merge`");
	const merged = mergedTree(cwd, theirs);
	const page = merged === undefined ? undefined : catalogOfTree(cwd, merged);
	if (page === undefined)
		return unresolved(CATALOG_PATH, "is generated from sources that conflict");
	writeFileSync(files.ours, page);
	return 0;
}

export function refresh(cwd: string): number {
	const pins = pinsOfWorktree(cwd);
	const target = join(cwd, PINS_PATH);
	if (pins === undefined) return 1;
	writeFileSync(target, writePins(readFileSync(target, "utf8"), pins));
	writeFileSync(
		join(cwd, CATALOG_PATH),
		renderCatalog(collectCodes(readSources(cwd))),
	);
	return 0;
}

function main(argv: readonly string[], cwd: string): number {
	const [mode, base, ours, theirs] = argv;
	if (mode === "refresh") return refresh(cwd);
	if (base === undefined || ours === undefined || theirs === undefined) {
		process.stderr.write(
			"usage: merge-driver.mts pins|catalog %O %A %B %P | refresh\n",
		);
		return 2;
	}
	if (mode === "pins") return mergePins(cwd, { base, ours, theirs });
	if (mode === "catalog") return mergeCatalog(cwd, { ours });
	process.stderr.write(`merge-driver: unknown mode ${mode}\n`);
	return 2;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
	process.exitCode = main(process.argv.slice(2), resolve(process.cwd()));

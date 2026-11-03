/**
 * Bounds the Turbo local cache that actions/cache saves, and says whether this
 * job added anything worth saving.
 *
 * Usage: node --experimental-strip-types scripts/ci/turbo-cache-prune.mts [repoRoot]
 *
 * Every entry a `.turbo/runs/*.json` summary from this job names (hit or miss)
 * is kept and stamped as used now. Any other restored entry is kept while it
 * was used within `HOBO_TURBO_CACHE_KEEP_DAYS` (default 7) and dropped after:
 * an affected-only main run touches a handful of packages, and keeping only
 * those shrank main's cache until the next run rebuilt everything.
 *
 * With `GITHUB_OUTPUT` set it writes `save=false` when no task missed the cache
 * and left an entry, so the workflow skips the save step (and the action
 * download it starts with) when the restored cache already holds every result.
 * With no summaries it deletes nothing and has nothing to save; with an
 * unreadable one it deletes nothing and saves.
 *
 * Node builtins only: the step runs with `if: always()`, also on a job whose
 * `pnpm install` failed.
 */
import {
	appendFileSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RunTask = Readonly<{ hash: string; missed: boolean }>;

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [key: string]: Json };

type JsonObject = { readonly [key: string]: Json };

const tag = (value: Json | undefined): string =>
	Object.prototype.toString.call(value);
function isObject(value: Json | undefined): value is JsonObject {
	return tag(value) === "[object Object]";
}
function isList(value: Json | undefined): value is readonly Json[] {
	return tag(value) === "[object Array]";
}
function isString(value: Json | undefined): value is string {
	return tag(value) === "[object String]";
}

/** The tasks of a `.turbo/runs/*.json` summary; `undefined` when it is not one. */
export function parseRunTasks(json: string): RunTask[] | undefined {
	let summary: Json;
	try {
		summary = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!isObject(summary) || !isList(summary.tasks)) return undefined;
	const parsed: RunTask[] = [];
	for (const task of summary.tasks) {
		if (!isObject(task) || !isString(task.hash) || task.hash === "")
			return undefined;
		const cache = task.cache;
		parsed.push({
			hash: task.hash,
			missed: isObject(cache) && cache.status === "MISS",
		});
	}
	return parsed;
}

/** `<hash>.tar.zst`, `<hash>-meta.json`, `<hash>-manifest.json` → `<hash>`. */
export function entryHash(fileName: string): string {
	return fileName.split(/[.-]/u, 1)[0] ?? fileName;
}

export type CacheFile = Readonly<{ name: string; mtimeMs: number }>;

export type PrunePlan = Readonly<{
	keep: readonly string[];
	drop: readonly string[];
	save: boolean;
}>;

/**
 * Which files to stamp as used, which to delete, and whether the result is
 * worth saving. `tasks` is every task of every summary this job wrote.
 */
export function planPrune(
	files: readonly CacheFile[],
	tasks: readonly RunTask[],
	nowMs: number,
	keepDays: number,
): PrunePlan {
	if (tasks.length === 0) return { keep: [], drop: [], save: false };
	const used = new Set(tasks.map((task) => task.hash));
	const missed = new Set(
		tasks.filter((task) => task.missed).map((task) => task.hash),
	);
	const cutoff = nowMs - keepDays * DAY_MS;
	const keep: string[] = [];
	const drop: string[] = [];
	for (const file of files) {
		const hash = entryHash(file.name);
		if (used.has(hash)) keep.push(file.name);
		else if (file.mtimeMs < cutoff) drop.push(file.name);
	}
	return {
		keep,
		drop,
		save: files.some((file) => missed.has(entryHash(file.name))),
	};
}

function listDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function keepDays(): number {
	const days = Number(process.env.HOBO_TURBO_CACHE_KEEP_DAYS ?? "7");
	return Number.isFinite(days) && days >= 0 ? days : 7;
}

function output(save: boolean): void {
	const path = process.env.GITHUB_OUTPUT;
	if (path) appendFileSync(path, `save=${save}\n`);
}

function main(root: string): void {
	const runsDir = join(root, ".turbo", "runs");
	const cacheDir = join(root, ".turbo", "cache");
	const tasks: RunTask[] = [];
	for (const file of listDir(runsDir)) {
		if (!file.endsWith(".json")) continue;
		const parsed = parseRunTasks(readFileSync(join(runsDir, file), "utf8"));
		if (!parsed) {
			// A run whose hashes are unknown could have used any entry.
			console.log(
				`turbo-cache-prune: unreadable ${file}; cache left as restored`,
			);
			output(true);
			return;
		}
		tasks.push(...parsed);
	}
	const files = listDir(cacheDir).map((name) => ({
		name,
		mtimeMs: statSync(join(cacheDir, name)).mtimeMs,
	}));
	const now = Date.now();
	const plan = planPrune(files, tasks, now, keepDays());
	const stamp = new Date(now);
	for (const file of plan.keep) utimesSync(join(cacheDir, file), stamp, stamp);
	for (const file of plan.drop) rmSync(join(cacheDir, file), { force: true });
	output(plan.save);
	console.log(
		tasks.length === 0
			? "turbo-cache-prune: no run summaries; cache left as restored, nothing to save"
			: `turbo-cache-prune: ${plan.keep.length} file(s) used by ${new Set(tasks.map((task) => task.hash)).size} task hash(es), ${files.length - plan.keep.length - plan.drop.length} kept from earlier runs, ${plan.drop.length} dropped; ${plan.save ? "new entries to save" : "no new entries, skipping the save"}`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv[2] ?? process.cwd());
}

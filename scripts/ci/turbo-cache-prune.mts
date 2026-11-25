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

export function entryHash(fileName: string): string {
	return fileName.split(/[.-]/u, 1)[0] ?? fileName;
}

export type CacheFile = Readonly<{ name: string; mtimeMs: number }>;

export type PrunePlan = Readonly<{
	keep: readonly string[];
	drop: readonly string[];
	save: boolean;
}>;

export function planPrune(
	files: readonly CacheFile[],
	tasks: readonly RunTask[],
	nowMs: number,
	keepDays: number,
	incremental = false,
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
		if (incremental) {
			if (missed.has(hash)) keep.push(file.name);
			else drop.push(file.name);
		} else if (used.has(hash)) keep.push(file.name);
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

export function cacheDirOf(
	root: string,
	env: Readonly<Record<string, string | undefined>>,
): string {
	const dir = env.TURBO_CACHE_DIR;
	return dir ? dir : join(root, ".turbo", "cache");
}

export function localReadOnly(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	return (env.TURBO_CACHE ?? "")
		.split(",")
		.some((part) => part.trim() === "local:r");
}

export function lacksRemoteTurboCacheTier(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	return !(env.TURBO_CACHE ?? "")
		.split(",")
		.some((part) => part.trim().startsWith("remote:"));
}

function mtimeOf(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
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
	const cacheDir = cacheDirOf(root, process.env);
	const shared = process.env.HOBO_TURBO_CACHE_SHARED === "1";
	const save = (worth: boolean) => output(worth && !shared);
	if (localReadOnly(process.env)) {
		output(false);
		console.log("turbo-cache-prune: local cache is read-only; left as is");
		return;
	}
	const tasks: RunTask[] = [];
	for (const file of listDir(runsDir)) {
		if (!file.endsWith(".json")) continue;
		const parsed = parseRunTasks(readFileSync(join(runsDir, file), "utf8"));
		if (!parsed) {
			console.log(
				`turbo-cache-prune: unreadable ${file}; cache left as restored`,
			);
			save(true);
			return;
		}
		tasks.push(...parsed);
	}
	const files: CacheFile[] = [];
	for (const name of listDir(cacheDir)) {
		const mtimeMs = mtimeOf(join(cacheDir, name));
		if (mtimeMs !== undefined) files.push({ name, mtimeMs });
	}
	const now = Date.now();
	const incremental =
		process.env.HOBO_TURBO_CACHE_RUN_SHARED === "1" &&
		!shared &&
		lacksRemoteTurboCacheTier(process.env);
	const plan = planPrune(files, tasks, now, keepDays(), incremental);
	const stamp = new Date(now);
	for (const file of plan.keep) {
		try {
			utimesSync(join(cacheDir, file), stamp, stamp);
		} catch {
		}
	}
	for (const file of plan.drop) rmSync(join(cacheDir, file), { force: true });
	save(plan.save);
	console.log(
		tasks.length === 0
			? "turbo-cache-prune: no run summaries; cache left as restored, nothing to save"
			: `turbo-cache-prune: ${plan.keep.length} file(s) used by ${new Set(tasks.map((task) => task.hash)).size} task hash(es), ${files.length - plan.keep.length - plan.drop.length} kept from earlier runs, ${plan.drop.length} dropped; ${shared ? "shared host cache, no save" : plan.save ? "new entries to save" : "no new entries, skipping the save"}`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv[2] ?? process.cwd());
}

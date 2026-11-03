/**
 * Drops Turbo local-cache entries this job's runs did not touch, so the
 * `.turbo/cache` saved to actions/cache stays the size of one run instead of
 * accumulating every entry every earlier save restored.
 *
 * Usage: node --experimental-strip-types scripts/ci/turbo-cache-prune.mts [repoRoot]
 *
 * Keeps every entry whose hash a `.turbo/runs/*.json` summary names (hit or
 * miss). With no summaries it deletes nothing: a job that never reached turbo
 * must not wipe the cache it restored.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const RunHashes = z.object({
	tasks: z.array(z.object({ hash: z.string().min(1) }).passthrough()),
});
export type RunHashes = z.infer<typeof RunHashes>;

/** Parses a `.turbo/runs/*.json` summary; `undefined` when it is not one. */
export function parseRunHashes(json: string): RunHashes | undefined {
	try {
		const parsed = RunHashes.safeParse(JSON.parse(json));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

/** `<hash>.tar.zst`, `<hash>-meta.json`, `<hash>-manifest.json` → `<hash>`. */
export function entryHash(fileName: string): string {
	return fileName.split(/[.-]/u, 1)[0] ?? fileName;
}

export function filesToPrune(
	cacheFiles: readonly string[],
	keep: ReadonlySet<string>,
): string[] {
	if (keep.size === 0) return [];
	return cacheFiles.filter((file) => !keep.has(entryHash(file)));
}

function listDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function main(root: string): void {
	const runsDir = join(root, ".turbo", "runs");
	const cacheDir = join(root, ".turbo", "cache");
	const keep = new Set<string>();
	for (const file of listDir(runsDir)) {
		if (!file.endsWith(".json")) continue;
		const summary = parseRunHashes(readFileSync(join(runsDir, file), "utf8"));
		if (!summary) {
			// A run whose hashes are unknown could have used any entry.
			console.log(
				`turbo-cache-prune: unreadable ${file}; cache left as restored`,
			);
			return;
		}
		for (const task of summary.tasks) keep.add(task.hash);
	}
	const cacheFiles = listDir(cacheDir);
	const prune = filesToPrune(cacheFiles, keep);
	for (const file of prune) rmSync(join(cacheDir, file), { force: true });
	console.log(
		keep.size === 0
			? "turbo-cache-prune: no run summaries; cache left as restored"
			: `turbo-cache-prune: kept ${cacheFiles.length - prune.length} file(s) for ${keep.size} task hash(es), dropped ${prune.length}`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv[2] ?? process.cwd());
}

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";

export const BROWSER_WIT_WORK_CACHE_RELATIVE =
	".cache/browser-wit-componentize" as const;

export function browserWitWorkCacheDir(repoRoot: string): string {
	return path.join(repoRoot, BROWSER_WIT_WORK_CACHE_RELATIVE);
}

export async function createBrowserWitComponentizeWorkRoot(
	repoRoot: string,
): Promise<{ readonly logical: string; readonly canonical: string }> {
	const parent = browserWitWorkCacheDir(repoRoot);
	await mkdir(parent, { recursive: true });
	const logical = await mkdtemp(path.join(parent, "work-"));
	const canonical = await realpath(logical);
	return { logical, canonical };
}

export async function removeBrowserWitWorkRoot(
	workRootLogical: string,
): Promise<void> {
	await rm(workRootLogical, { recursive: true, force: true });
}

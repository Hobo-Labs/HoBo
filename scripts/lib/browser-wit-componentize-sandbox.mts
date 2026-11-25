import { realpathSync } from "node:fs";
import { cp, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { assertReleasePagesBrowserRuntimeWit } from "./release-pages-wit.mts";

export const SANDBOX_WIT_DIR_NAME = "wit" as const;
export const SANDBOX_WIT_STATION_FILE = "station.wit" as const;
export const COMPONENTIZE_WIT_PATH = `${SANDBOX_WIT_DIR_NAME}/${SANDBOX_WIT_STATION_FILE}` as const;
export const BROWSER_WIT_GUEST_SOURCE_NAME = "station-guest.mjs" as const;

export function componentizeWitDirUnderWorkRoot(workRoot: string): string {
	return path.join(workRoot, SANDBOX_WIT_DIR_NAME);
}

export async function resolveComponentizeHostWitPath(
	sandboxWitDir: string,
): Promise<string> {
	return realpath(path.join(path.resolve(sandboxWitDir), "station.wit"));
}

export async function readInlineComponentizeWit(
	sandboxWitDir: string,
): Promise<string> {
	const stationWit = await resolveComponentizeHostWitPath(sandboxWitDir);
	return readFile(stationWit, "utf8");
}

export function guestSourcePathInWorkRoot(workRoot: string): string {
	return path.join(workRoot, BROWSER_WIT_GUEST_SOURCE_NAME);
}

export function assertGuestSourceUnderWorkRoot(
	sourcePath: string,
	workRoot: string,
): void {
	const resolvedSource = path.resolve(sourcePath);
	const resolvedRoot = path.resolve(workRoot);
	const rootPrefix = resolvedRoot.endsWith(path.sep)
		? resolvedRoot
		: `${resolvedRoot}${path.sep}`;
	if (!resolvedSource.startsWith(rootPrefix)) {
		throw new Error(
			`browser-wit: componentize sourcePath must live under workRoot (${workRoot}); got ${sourcePath}`,
		);
	}
	if (path.basename(resolvedSource) !== BROWSER_WIT_GUEST_SOURCE_NAME) {
		throw new Error(
			`browser-wit: componentize guest source must be ${BROWSER_WIT_GUEST_SOURCE_NAME} under workRoot`,
		);
	}
}

export function witPathIsUnderWorkRoot(
	witPath: string,
	workRoot: string,
): boolean {
	let resolvedWit: string;
	let resolvedRoot: string;
	try {
		resolvedWit = realpathSync.native(path.resolve(witPath));
		resolvedRoot = realpathSync.native(path.resolve(workRoot));
	} catch {
		resolvedWit = path.resolve(witPath);
		resolvedRoot = path.resolve(workRoot);
	}
	const rootPrefix = resolvedRoot.endsWith(path.sep)
		? resolvedRoot
		: `${resolvedRoot}${path.sep}`;
	if (resolvedWit === resolvedRoot) {
		return false;
	}
	return resolvedWit.startsWith(rootPrefix);
}

export async function copyHostWitTreeIntoWorkRoot(
	hostWitDir: string,
	workRoot: string,
): Promise<string> {
	const sandboxWitDir = componentizeWitDirUnderWorkRoot(workRoot);
	await cp(hostWitDir, sandboxWitDir, { recursive: true, force: true });
	return sandboxWitDir;
}

export async function assertSandboxWitBeforeComponentize(
	sandboxWitDir: string,
	workRoot: string,
	repoRoot: string,
	hostWitDir: string,
	gitRef = "HEAD",
): Promise<void> {
	if (!witPathIsUnderWorkRoot(sandboxWitDir, workRoot)) {
		throw new Error(
			`browser-wit: componentize witPath must live under workRoot (${workRoot}); got ${sandboxWitDir}`,
		);
	}
	const stationWit = path.join(sandboxWitDir, "station.wit");
	let stationBytes: Buffer;
	try {
		stationBytes = await readFile(stationWit);
	} catch {
		throw new Error(
			`browser-wit: sandbox missing station.wit at ${stationWit} before componentize`,
		);
	}
	if (stationBytes.byteLength === 0) {
		throw new Error(
			"browser-wit: sandbox station.wit is empty before componentize",
		);
	}
	const hostStation = path.join(hostWitDir, "station.wit");
	const hostBytes = await readFile(hostStation);
	if (!hostBytes.equals(stationBytes)) {
		throw new Error(
			"browser-wit: sandbox station.wit does not match host tree after copy",
		);
	}
	assertReleasePagesBrowserRuntimeWit(repoRoot, gitRef);
	await logSandboxWitListing(sandboxWitDir);
}

async function logSandboxWitListing(sandboxWitDir: string): Promise<void> {
	process.stderr.write(`browser-wit: listing sandbox wit ${sandboxWitDir}\n`);
	for (const name of (await readdir(sandboxWitDir)).sort()) {
		const full = path.join(sandboxWitDir, name);
		const info = await stat(full);
		const kind = info.isDirectory() ? "d" : "-";
		process.stderr.write(
			`browser-wit: wit sandbox ${kind}${name} ${info.size}b\n`,
		);
	}
}

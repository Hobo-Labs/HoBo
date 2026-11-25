import { cp, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { assertReleasePagesBrowserRuntimeWit } from "./release-pages-wit.mts";

export const SANDBOX_WIT_DIR_NAME = "wit" as const;

export function componentizeWitDirUnderWorkRoot(workRoot: string): string {
	return path.join(workRoot, SANDBOX_WIT_DIR_NAME);
}

export function witPathIsUnderWorkRoot(
	witPath: string,
	workRoot: string,
): boolean {
	const relative = path.relative(workRoot, path.resolve(witPath));
	if (relative === "") {
		return false;
	}
	return !relative.startsWith("..") && !path.isAbsolute(relative);
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

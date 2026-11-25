import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const CUE_VERSION = "v0.14.0";

function pinned(binary: string, source: string): string {
	let version: string;
	try {
		version = execFileSync(binary, ["version"], { encoding: "utf8" });
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		throw new Error(
			`cue ${CUE_VERSION} not found (${source} ${binary}: ${reason}): set HOBO_CUE_BIN or put cue ${CUE_VERSION} on PATH`,
		);
	}
	const firstLine = version.split(/\r?\n/u)[0] ?? "";
	const found = /^cue version (v?\S+)$/u.exec(firstLine.trim())?.[1];
	if (found?.replace(/^v/u, "") !== CUE_VERSION.slice(1)) {
		const named = found === undefined ? `"${firstLine}"` : `cue ${found}`;
		throw new Error(
			`${source} ${binary} is ${named}, not cue ${CUE_VERSION}`,
		);
	}
	return binary;
}

export function cueBinary(env: NodeJS.ProcessEnv, repoRoot: string): string {
	const configured = env.HOBO_CUE_BIN;
	if (configured !== undefined && configured !== "") {
		if (!existsSync(configured)) {
			throw new Error(
				`HOBO_CUE_BIN names ${configured}, which does not exist`,
			);
		}
		return pinned(configured, "HOBO_CUE_BIN");
	}
	const exe = process.platform === "win32" ? "cue.exe" : "cue";
	const cached = join(repoRoot, ".tools", "cue", CUE_VERSION, exe);
	if (existsSync(cached)) return pinned(cached, "the cached");
	return pinned("cue", "PATH's");
}
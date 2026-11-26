/** Vet a serialized JSON document against a CUE definition with the pinned cue binary. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CUE_NAME = process.platform === "win32" ? "cue.exe" : "cue";

/** The repo pins cue under `.tools/cue/v0.14.0`; a worktree finds the checkout's copy. */
function cueBinary(): string {
	if (process.env.HOBO_CUE_BIN) return process.env.HOBO_CUE_BIN;
	let directory = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = join(directory, ".tools", "cue", "v0.14.0", CUE_NAME);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory)
			throw new Error(
				"pinned cue v0.14.0 not found; run scripts/bootstrap-dev.sh or set HOBO_CUE_BIN",
			);
		directory = parent;
	}
}

export function cueVet(
	cueFile: string,
	definition: string,
	serializedJson: string,
): void {
	const directory = mkdtempSync(join(tmpdir(), "wp14-cue-"));
	try {
		const json = join(directory, "document.json");
		writeFileSync(json, serializedJson);
		execFileSync(
			cueBinary(),
			[
				"vet",
				fileURLToPath(new URL(`../../data-models/${cueFile}`, import.meta.url)),
				json,
				"-d",
				definition,
			],
			{ stdio: "pipe" },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

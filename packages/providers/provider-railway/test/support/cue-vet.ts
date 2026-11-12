/** Vet a serialized JSON document against a CUE definition with the pinned cue binary. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CUE_BIN =
	process.env.HOBO_CUE_BIN ||
	fileURLToPath(
		new URL(
			`../../../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
			import.meta.url,
		),
	);

export function cueVet(
	cueFile: string,
	definition: string,
	serializedJson: string,
): void {
	const directory = mkdtempSync(join(tmpdir(), "wp13-cue-"));
	try {
		const json = join(directory, "document.json");
		writeFileSync(json, serializedJson);
		execFileSync(
			CUE_BIN,
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

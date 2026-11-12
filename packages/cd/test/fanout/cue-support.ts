// `cue vet` driver for the WP23 CUE agreement tests. Finds `cue` on PATH,
// else the repo-pinned binary under an ancestor's `.tools/cue/<version>/cue`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function findCue(): string | undefined {
	try {
		execFileSync("cue", ["version"], { stdio: "ignore" });
		return "cue";
	} catch {
		let directory = here;
		while (dirname(directory) !== directory) {
			const tools = join(directory, ".tools", "cue");
			if (existsSync(tools)) {
				for (const version of readdirSync(tools).sort().reverse()) {
					const binary = join(tools, version, "cue");
					if (existsSync(binary)) return binary;
				}
			}
			directory = dirname(directory);
		}
		return undefined;
	}
}

export const cue = findCue();

export type Vet = (definition: string, value: unknown) => Readonly<{ ok: boolean; error: string }>;

/** A vetter bound to one schema under packages/cd/data-models. */
export function vetter(schemaFile: string): Vet {
	const schema = resolve(here, "../../data-models", schemaFile);
	const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-wp23-cue-"));
	let written = 0;
	return (definition, value) => {
		if (!cue) throw new Error("cue binary not found");
		written += 1;
		const file = join(scratch, `value-${written}.json`);
		writeFileSync(file, JSON.stringify(value));
		try {
			execFileSync(cue, ["vet", "-c", "-d", definition, schema, file], { stdio: "pipe" });
			return { ok: true, error: "" };
		} catch (error) {
			const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : String(error);
			return { ok: false, error: stderr };
		}
	};
}

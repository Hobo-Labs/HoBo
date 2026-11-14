// `cue vet` driver shared by the WP22 CUE agreement tests. Finds `cue` on
// PATH, else the repo-pinned binary under an ancestor's `.tools/cue/<version>/cue`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@bufbuild/protobuf";

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

/** A vetter bound to one schema under packages/cd/data-models. */
export function vetter(schemaFile: string) {
	const schema = resolve(here, "../../data-models", schemaFile);
	const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-wp22-cue-"));
	let written = 0;
	return (definition: string, value: JsonValue): boolean => {
		if (!cue) throw new Error("cue binary not found");
		written += 1;
		const file = join(scratch, `value-${written}.json`);
		writeFileSync(file, JSON.stringify(value));
		try {
			execFileSync(cue, ["vet", "-c", "-d", definition, schema, file], {
				stdio: "pipe",
			});
			return true;
		} catch {
			return false;
		}
	};
}

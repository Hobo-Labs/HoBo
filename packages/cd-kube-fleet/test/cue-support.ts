// `cue vet` driver for the kube_fleet.cue agreement tests. Finds `cue` on
// PATH, else the repo-pinned binary under an ancestor's `.tools/cue/<version>/cue`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@hobo/core";

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

const schema = resolve(here, "../data-models/kube_fleet.cue");
const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-kube-fleet-cue-"));
let written = 0;

/** Whether `value` vets against `definition` in kube_fleet.cue. */
export function vets(definition: string, value: JsonValue): boolean {
	if (cue === undefined) throw new Error("cue binary not found");
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
}

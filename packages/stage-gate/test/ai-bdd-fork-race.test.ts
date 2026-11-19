import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";
import { runAiBdd } from "../src/ai-bdd-process.js";
import { killQuietly } from "./helpers/release-gate.js";

const HOP = join(dirname(fileURLToPath(import.meta.url)), "helpers", "hop.sh");
const RUNS = 10;

const scratch = mkdtempSync(join(tmpdir(), "hobo-fork-race-"));
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function survivors(token: string): number[] {
	const found: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/u.test(entry)) continue;
		try {
			if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(token)) {
				found.push(Number(entry));
			}
		} catch {
		}
	}
	return found;
}

describe("runAiBdd on Linux, against a member that forks and exits while it is stopped", () => {
	it.runIf(process.platform === "linux")(
		`leaves none of ${RUNS} hopping groups running`,
		async () => {
			const token = join(scratch, "hop-");
			try {
				await Promise.all(
					Array.from({ length: RUNS }, (_, run) =>
						runAiBdd(
							{
								command: [
									"sh",
									"-c",
									'sh "$0" 100 "$1" "$1.ready" >/dev/null 2>&1 & i=0; until [ -e "$1.ready" ] || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done; exit 0',
									HOP,
									`${token}${run}`,
								],
								cwd: tmpdir(),
								env: process.env,
								timeoutMs: 20_000,
								graceMs: 1500,
								relay: () => undefined,
							},
							[],
						),
					),
				);
				const unstarted = Array.from({ length: RUNS }, (_, run) => run).filter(
					(run) => !existsSync(`${token}${run}.ready`),
				);
				expect(unstarted).toEqual([]);
				const deadline = Date.now() + 2000;
				while (survivors(token).length > 0 && Date.now() < deadline) {
					await new Promise((done) => setTimeout(done, 100));
				}
				expect(survivors(token)).toEqual([]);
			} finally {
				for (const pid of survivors(token)) killQuietly(pid);
			}
		},
		60_000,
	);
});

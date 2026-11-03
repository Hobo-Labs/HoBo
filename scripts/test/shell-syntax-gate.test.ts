import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

/** Release/CI shell entrypoints always validated (not only when git-diff changed). */
const PINNED_SHELL_SCRIPTS = [
	"packages/ci-gh-actions/deploy/ci-runner/build.sh",
] as const;

function bashSyntaxOk(path: string): boolean {
	const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
	return result.status === 0;
}

describe("pinned shell scripts (bash -n)", () => {
	for (const rel of PINNED_SHELL_SCRIPTS) {
		it(`${rel} passes bash -n`, () => {
			const path = join(root, rel);
			expect(existsSync(path)).toBe(true);
			expect(bashSyntaxOk(path)).toBe(true);
		});
	}
});

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkMergiraf,
	configuredStructuredMerger,
	createMergirafMerger,
} from "../src/structured-merge.js";
import { testConfig } from "./fixtures/config.js";

/**
 * A stand-in for mergiraf with its v0.20 command line: `merge BASE LEFT RIGHT
 * --path-name P --output OUT --timeout MS`. What it does is chosen by the
 * left side's first line, so each test drives it through its input.
 */
const SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "mergiraf 0.20.0"; exit 0; fi
[ "$1" = "merge" ] || exit 255
base="$2"; left="$3"; right="$4"; shift 4
while [ $# -gt 0 ]; do
  case "$1" in
    --path-name) path="$2"; shift 2;;
    --output) out="$2"; shift 2;;
    --timeout) timeout="$2"; shift 2;;
    *) exit 255;;
  esac
done
case "$(head -n 1 "$left")" in
  clean) { echo "merged $path in $(pwd) after $timeout"; env | sort; cat "$base" "$left" "$right"; } > "$out"; exit 0;;
  markers) printf '<<<<<<< left\\nx\\n=======\\ny\\n>>>>>>> right\\n' > "$out"; exit 0;;
  conflict) echo partial > "$out"; exit 1;;
  *) exit 255;;
esac
`;

describe("mergiraf as the structured merge", () => {
	let directory: string;
	let command: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "hobo-mgf-test-"));
		command = join(directory, "mergiraf");
		writeFileSync(command, SCRIPT);
		chmodSync(command, 0o755);
	});
	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	const input = (ours: string) => ({
		path: "src/a.ts",
		base: "base\n",
		ours,
		theirs: "theirs\n",
		signal: AbortSignal.timeout(10_000),
	});

	it("returns a clean merge, run in an empty directory with no inherited environment", async () => {
		process.env.HOBO_TEST_SECRET = "must-not-reach-mergiraf";
		try {
			const merged = await createMergirafMerger({
				command,
				timeoutMs: 1234,
			}).merge(input("clean\n"));
			expect(merged).toMatch(
				/^merged src\/a\.ts in \S*hobo-ci-agent-mgf-\S+ after 1234\n/,
			);
			expect(merged).toContain("base\nclean\ntheirs\n");
			expect(merged).not.toContain("HOBO_TEST_SECRET");
			expect(merged).toMatch(/\nXDG_CACHE_HOME=\S*hobo-ci-agent-mgf-/);
		} finally {
			delete process.env.HOBO_TEST_SECRET;
		}
	});

	it("leaves the merge to git on conflicts, markers, failures and a missing command", async () => {
		const merger = createMergirafMerger({ command });
		for (const ours of ["conflict\n", "markers\n", "fail\n"])
			expect(await merger.merge(input(ours))).toBeUndefined();
		expect(
			await createMergirafMerger({
				command: join(directory, "missing"),
			}).merge(input("clean\n")),
		).toBeUndefined();
	});

	it("is checked at start-up, and is off unless configured", async () => {
		await expect(checkMergiraf({ command })).resolves.toBeUndefined();
		await expect(
			checkMergiraf({ command: join(directory, "missing") }),
		).rejects.toThrow(
			"resolution.structuredMerge is on, but `mergiraf` is not installed",
		);
		expect(
			await configuredStructuredMerger(testConfig("suggest"), { command }),
		).toBeUndefined();
		const on = await configuredStructuredMerger(
			testConfig("suggest", { resolution: { structuredMerge: true } }),
			{ command },
		);
		expect(on?.id).toBe("mergiraf");
		expect(await on?.merge(input("clean\n"))).toContain("after 120000");
	});
});

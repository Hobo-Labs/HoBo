import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	RELEASE_PAGES_BROWSER_RUNTIME_WIT_FILE,
	assertReleasePagesBrowserRuntimeWit,
} from "../lib/release-pages-wit.mts";

const root = join(import.meta.dirname, "..", "..");

describe("release pages browser-runtime wit preflight", () => {
	it("station.wit on disk matches HEAD in this repository", () => {
		expect(existsSync(join(root, RELEASE_PAGES_BROWSER_RUNTIME_WIT_FILE))).toBe(
			true,
		);
		expect(() => assertReleasePagesBrowserRuntimeWit(root, "HEAD")).not.toThrow();
	});

	it("rejects a stale on-disk wit file that does not match HEAD (run 45539357482)", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-pages-wit-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: dir });
			execFileSync(
				"git",
				["config", "user.email", "wit-test@hobo.local"],
				{ cwd: dir },
			);
			execFileSync("git", ["config", "user.name", "wit-test"], { cwd: dir });
			const witDir = join(dir, "examples/browser-runtime/wit");
			mkdirSync(witDir, { recursive: true });
			const witFile = join(witDir, "station.wit");
			writeFileSync(witFile, "package hobo:station@0.1.0;\n", "utf8");
			execFileSync("git", ["add", "."], { cwd: dir });
			execFileSync("git", ["commit", "-q", "-m", "wit"], { cwd: dir });
			writeFileSync(witFile, "", "utf8");
			expect(() => assertReleasePagesBrowserRuntimeWit(dir, "HEAD")).toThrow(
				/empty/,
			);
			writeFileSync(witFile, "stale\n", "utf8");
			expect(() => assertReleasePagesBrowserRuntimeWit(dir, "HEAD")).toThrow(
				/does not match/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
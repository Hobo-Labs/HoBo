import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ISOLATED_TEST_FILES,
	PROCESS_STATE_CHANGE,
} from "./support/isolated-test-files.js";

const packageDir = join(import.meta.dirname, "..");

function testFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return testFiles(path);
		return entry.name.endsWith(".test.ts")
			? [relative(packageDir, path).split("\\").join("/")]
			: [];
	});
}

describe("isolated test files", () => {
	// This file's samples below match the pattern on purpose.
	const files = testFiles(join(packageDir, "test"))
		.filter((file) => file !== "test/isolated-test-files.test.ts")
		.sort();
	const changing = files.filter((file) =>
		PROCESS_STATE_CHANGE.test(readFileSync(join(packageDir, file), "utf8")),
	);

	it("lists exactly the test files that change process-wide state", () => {
		expect([...ISOLATED_TEST_FILES].sort()).toEqual(changing);
	});

	it("recognises each kind of process-wide change", () => {
		for (const source of [
			"process.env.HOBO_HOME = home;",
			'process.env["X"] = "1";',
			"delete process.env.HOBO_HOME;",
			"globalThis.fetch = stub;",
			"process.chdir(dir);",
			'vi.stubEnv("X", "1");',
			'vi.spyOn(console, "log");',
			'vi.mock("node:fs");',
			"vi.useFakeTimers();",
		])
			expect(PROCESS_STATE_CHANGE.test(source), source).toBe(true);
		for (const source of [
			"process.env.HOBO_HOME === home",
			"const home = process.env.HOBO_HOME;",
			"{ env: { ...process.env, HOBO_HOME: home } }",
		])
			expect(PROCESS_STATE_CHANGE.test(source), source).toBe(false);
	});
});

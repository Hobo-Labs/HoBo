import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "code-test-build-artifact-"));
	temporaryDirectories.push(directory);
	return directory;
}

function write(root: string, path: string, contents: string): void {
	const destination = join(root, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, contents);
}

function run(script: string, args: readonly string[]): void {
	execFileSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			join(repoRoot, "scripts/ci", script),
			...args,
		],
		{ cwd: repoRoot, stdio: "pipe" },
	);
}

afterAll(() => {
	for (const directory of temporaryDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("code test build artifact", () => {
	it("roundtrips every package dist tree and no source files", () => {
		const source = temporaryDirectory();
		const destination = temporaryDirectory();
		const archive = join(temporaryDirectory(), "build.tar.gz");
		write(source, "packages/code/dist/bin/hobo-code.js", "code\n");
		write(source, "packages/hobo/dist/bin/hobo.js", "hobo\n");
		write(source, "packages/adapters/hono/dist/index.js", "hono\n");
		write(source, "packages/code/src/index.ts", "not packed\n");
		write(
			source,
			"packages/code/node_modules/ignored/dist/index.js",
			"not packed\n",
		);
		mkdirSync(join(source, "packages/empty/dist"), { recursive: true });

		run("pack-code-test-build-artifact.mts", [source, archive]);
		run("unpack-code-test-build-artifact.mts", [archive, destination]);

		for (const path of [
			"packages/code/dist/bin/hobo-code.js",
			"packages/hobo/dist/bin/hobo.js",
			"packages/adapters/hono/dist/index.js",
		]) {
			expect(readFileSync(join(destination, path), "utf8")).toBe(
				readFileSync(join(source, path), "utf8"),
			);
		}
		expect(existsSync(join(destination, "packages/empty/dist"))).toBe(true);
		expect(existsSync(join(destination, "packages/code/src"))).toBe(false);
		expect(existsSync(join(destination, "packages/code/node_modules"))).toBe(
			false,
		);
	});
});

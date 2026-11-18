/**
 * Case X03: the relay never runs code from the job. The runner protocol
 * module reads the job message and completes it; nothing in it can start a
 * process, so this test reads its sources and fails on any import or call
 * that could.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIRECTORY = new URL("../src/runner-protocol/", import.meta.url);
const SOURCES = readdirSync(DIRECTORY)
	.filter((name) => name.endsWith(".ts"))
	.map((name) => ({
		name,
		text: readFileSync(new URL(name, DIRECTORY), "utf8"),
	}));

/** Every module the runner protocol may import. None of them starts a process. */
const ALLOWED = new Set([
	"@bufbuild/protobuf",
	"@hobo/ci",
	"zod",
	"node:buffer",
	"node:crypto",
]);

function imports(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(
		/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/gu,
	))
		found.push(match[1] ?? "");
	return found;
}

describe("runner protocol safety (X03)", () => {
	it("has sources to check", () => {
		expect(SOURCES.map((source) => source.name)).toEqual(
			expect.arrayContaining([
				"client.ts",
				"fake-service.ts",
				"jit-config.ts",
				"json.ts",
				"port.ts",
				"wire.ts",
			]),
		);
	});

	it.each(SOURCES)("$name imports only modules that start no process", ({
		text,
	}) => {
		for (const specifier of imports(text))
			expect(
				specifier.startsWith("./") || ALLOWED.has(specifier),
				`imports ${specifier}`,
			).toBe(true);
	});

	it.each(SOURCES)("$name names nothing that runs a program", ({ text }) => {
		for (const pattern of [
			/child_process/u,
			/worker_threads/u,
			/node:cluster/u,
			/\bspawn\s*\(/u,
			/\bexecFile\s*\(/u,
			/\bexecSync\s*\(/u,
			/\bfork\s*\(/u,
			/new\s+Worker\s*\(/u,
			/\beval\s*\(/u,
			/new\s+Function\s*\(/u,
			/process\.(?:binding|dlopen|kill)/u,
		])
			expect(text, String(pattern)).not.toMatch(pattern);
	});

	it("catches an import that could start a process", () => {
		expect(imports('import { spawn } from "node:child_process";')).toEqual([
			"node:child_process",
		]);
		expect(imports('const m = await import("execa");')).toEqual(["execa"]);
	});
});

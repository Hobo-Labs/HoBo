import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = new URL("../src/", import.meta.url);
const ENTRIES = ["relay-answer/index.ts"];

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

function closure(): ReadonlyMap<string, string> {
	const seen = new Map<string, string>();
	const pending = [...ENTRIES];
	while (pending.length > 0) {
		const path = pending.pop() ?? "";
		if (seen.has(path)) continue;
		const text = readFileSync(new URL(path, SOURCE_ROOT), "utf8");
		seen.set(path, text);
		for (const specifier of imports(text))
			if (specifier.startsWith("."))
				pending.push(
					new URL(specifier, new URL(path, SOURCE_ROOT)).href
						.slice(SOURCE_ROOT.href.length)
						.replace(/\.js$/u, ".ts"),
				);
	}
	return seen;
}

const SOURCES = [...closure()].map(([name, text]) => ({ name, text }));

describe("relay mode safety (X03)", () => {
	it("follows relay mode into the modules it loads", () => {
		expect(SOURCES.map((source) => source.name)).toEqual(
			expect.arrayContaining([
				"relay-answer/answerer.ts",
				"relay-answer/ci-file.ts",
				"relay-answer/store-facts.ts",
				"runner-protocol/jit-config.ts",
				"runner-protocol/wire.ts",
				"github.ts",
			]),
		);
	});

	it.each(SOURCES)("$name imports only modules that start no process", ({
		text,
	}) => {
		for (const specifier of imports(text))
			expect(
				specifier.startsWith("./") ||
					specifier.startsWith("../") ||
					ALLOWED.has(specifier),
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
});

import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { overlayCompilerHost } from "../src/codegen/typescript-project-engine.js";

describe("TypeScript codegen compiler host", () => {
	it("reuses default library syntax trees without caching source overrides", () => {
		const languageVersion = ts.ScriptTarget.ES2022;
		const options: ts.CompilerOptions = { target: languageVersion };
		const defaultLib = ts.getDefaultLibFilePath(options);
		const firstHost = overlayCompilerHost(options, new Map());
		const secondHost = overlayCompilerHost(options, new Map());
		const first = firstHost.getSourceFile(defaultLib, languageVersion);
		const second = secondHost.getSourceFile(defaultLib, languageVersion);
		if (!first || !second) throw new Error("default library did not load");
		expect(second).toBe(first);

		const source = resolve("src/_generated/index.ts");
		const original = overlayCompilerHost(
			options,
			new Map([[source, "export const value = 1;"]]),
		).getSourceFile(source, languageVersion);
		const changed = overlayCompilerHost(
			options,
			new Map([[source, "export const value = 2;"]]),
		).getSourceFile(source, languageVersion);
		if (!original || !changed) throw new Error("source override did not load");
		expect(changed).not.toBe(original);
		expect(changed.text).toBe("export const value = 2;");
	});
});

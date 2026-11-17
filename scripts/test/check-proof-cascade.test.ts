import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sameNotebookExecution } from "../check-proof-cascade.js";

function notebook(
	source: string,
	output = "ok",
	language = "typescript",
): string {
	return JSON.stringify({
		metadata: { language_info: { name: language } },
		cells: [
			{ cell_type: "code", source: [source], outputs: [{ text: output }] },
		],
	});
}

describe("proof cascade notebook changes", () => {
	it("ignores explanatory comments when code and output are unchanged", () => {
		assert.equal(
			sameNotebookExecution(
				notebook("// explanation\nconst value = 1;\n"),
				notebook("const value = 1;\n"),
			),
			true,
		);
	});

	it("keeps code, output, compiler directives, and deferred work in the cascade", () => {
		for (const [before, after] of [
			[notebook("const value = 1;"), notebook("const value = 2;")],
			[notebook("const value = 1;", "a"), notebook("const value = 1;", "b")],
			[
				notebook("// @ts-ignore\nconst value = 1;"),
				notebook("const value = 1;"),
			],
			[
				notebook("// TODO implement\nconst value = 1;"),
				notebook("const value = 1;"),
			],
		] as const)
			assert.equal(sameNotebookExecution(before, after), false);
	});

	it("treats malformed, invalid, and unsupported notebooks as changed", () => {
		assert.equal(sameNotebookExecution("{", "{"), false);
		assert.equal(
			sameNotebookExecution(notebook("const = ;"), notebook("const = ;")),
			false,
		);
		assert.equal(
			sameNotebookExecution(
				notebook("# explanation\nx = 1", "ok", "python"),
				notebook("x = 1", "ok", "python"),
			),
			false,
		);
	});
});

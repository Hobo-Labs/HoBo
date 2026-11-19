import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isIdentityScaffold,
	removesOnlyIdentityDeclarations,
	sameNotebookExecution,
	sameProofExecution,
} from "../check-proof-cascade.js";

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

describe("proof cascade scaffold cleanup", () => {
	const workspace = "src/draft/technical-proofs/sample";
	const files = [
		`${workspace}/examples/proof-identity.ts`,
		`${workspace}/examples/proof-identity.expected.txt`,
		`${workspace}/bench/identity.bench.ts`,
		`${workspace}/notebook.ipynb`,
	];
	const before = JSON.stringify({
		artifacts: {
			examples: "examples",
			bench: "bench",
			notebook: "notebook.ipynb",
			diagrams: [],
		},
		references: ["dependency"],
	});
	const after = JSON.stringify({
		artifacts: { diagrams: [] },
		references: ["dependency"],
	});

	it("recognizes identity-only files by both path and content", () => {
		const content = "slug: sample\nlayer: technical\nproof-identity: ok\n";
		assert.equal(
			isIdentityScaffold(
				`${workspace}/examples/proof-identity.expected.txt`,
				content,
			),
			true,
		);
		assert.equal(
			isIdentityScaffold(
				`${workspace}/examples/proof-identity.expected.txt`,
				`${content}actual behavior\n`,
			),
			false,
		);
		assert.equal(
			isIdentityScaffold(`${workspace}/examples/real.ts`, content),
			false,
		);
	});

	it("ignores metadata only when all removed artifacts were identity scaffolds", () => {
		const prior = new Set(files);
		assert.equal(
			removesOnlyIdentityDeclarations(
				workspace,
				before,
				after,
				prior,
				new Set(files),
			),
			true,
		);
		assert.equal(
			removesOnlyIdentityDeclarations(
				workspace,
				before,
				after,
				prior,
				new Set(files.slice(1)),
			),
			false,
		);
		assert.equal(
			removesOnlyIdentityDeclarations(
				workspace,
				before,
				after,
				new Set([...files, `${workspace}/examples/real.ts`]),
				new Set(files),
			),
			false,
		);
		assert.equal(
			removesOnlyIdentityDeclarations(
				workspace,
				before,
				JSON.stringify({ artifacts: { diagrams: [] }, references: [] }),
				prior,
				new Set(files),
			),
			false,
		);
	});
});

describe("proof cascade source changes", () => {
	it("ignores prose and traceability locator migrations", () => {
		assert.equal(sameProofExecution("README.md", "old", "new"), true);
		assert.equal(
			sameProofExecution(
				"proof.ts",
				'export const ref = "docs/design/runtime.md#plan-1";\n',
				'export const ref = "urn:hobo:requirement:runtime#plan-1";\n',
			),
			true,
		);
		assert.equal(
			sameProofExecution(
				"pact.json",
				'{"ref":"docs/design/runtime.md#plan-1","status":"verified"}',
				'{"ref":"urn:hobo:requirement:runtime#plan-1","status":"verified"}',
			),
			true,
		);
	});

	it("keeps executable and directive changes in the cascade", () => {
		assert.equal(
			sameProofExecution(
				"proof.ts",
				"export const value = 1;\n",
				"export const value = 2;\n",
			),
			false,
		);
		assert.equal(
			sameProofExecution(
				"proof.ts",
				"// @ts-ignore\nexport const value = 1;\n",
				"export const value = 1;\n",
			),
			false,
		);
		assert.equal(
			sameProofExecution(
				"pact.json",
				'{"status":"verified"}',
				'{"status":"rejected"}',
			),
			false,
		);
	});
});

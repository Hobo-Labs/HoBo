import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const jco = join(dirname(require.resolve("@bytecodealliance/jco")), "jco.js");
const source = (text: string) =>
	ts.createSourceFile(
		"policy.d.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
const normalized = (text: string) =>
	ts.createPrinter({ removeComments: true }).printFile(source(text));

function evidenceFields(text: string): string[] {
	const declaration = source(text).statements.find(
		(node) => ts.isInterfaceDeclaration(node) && node.name.text === "Evidence",
	);
	if (!declaration || !ts.isInterfaceDeclaration(declaration))
		throw new Error("WIT evidence type missing");
	return declaration.members.map((member) => {
		if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name))
			throw new Error("invalid WIT evidence field");
		return member.name.text;
	});
}

it("generates both policy WIT versions and keeps the new binding current", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-policy-wit-"));
	try {
		const oldWit = fileURLToPath(
			new URL(
				"../../../src/draft/technical-proofs/policy-engine-port-contract/wit/world.wit",
				import.meta.url,
			),
		);
		const newWit = join(packageRoot, "wit/world.wit");
		const generate = (wit: string, output: string) => {
			execFileSync(
				process.execPath,
				[
					jco,
					"types",
					wit,
					"--world-name",
					"policy-engine-provider",
					"--out-dir",
					output,
				],
				{ stdio: "pipe", timeout: 60_000 },
			);
			return readFileSync(
				join(output, "interfaces/hobo-policy-engine-types.d.ts"),
				"utf8",
			);
		};
		const oldTypes = generate(oldWit, join(directory, "v1"));
		const newTypes = generate(newWit, join(directory, "v2"));
		const committed = readFileSync(
			join(packageRoot, "src/_generated/policy-engine-v2.ts"),
			"utf8",
		);
		expect(evidenceFields(oldTypes)).toEqual([
			"engine",
			"inputHash",
			"policyIds",
		]);
		expect(evidenceFields(newTypes)).toEqual([
			"engine",
			"inputHash",
			"policyIds",
			"packId",
			"packVersion",
		]);
		expect(normalized(newTypes)).toBe(normalized(committed));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 120_000);

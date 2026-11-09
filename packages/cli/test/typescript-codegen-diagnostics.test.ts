import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceDiagnostics } from "../src/codegen/typescript-diagnostics.js";
import {
	createTypeScriptProjectCodegenEngine,
	overlayCompilerHost,
} from "../src/codegen/typescript-project-engine.js";
import { slow } from "./support/slow.js";

let root: string;

const files: Record<string, string> = {
	"app.ts": [
		'import { shape } from "pkg";',
		"export const total: number = shape.size;",
		'export const wrong: number = "not a number";',
		"export async function later(): Promise<number> { return 1; }",
	].join("\n"),
	"helper.ts": "export function helper(input: string) { return input.nope; }",
	"test/app.test.ts": 'export const inTest: string = 1; import "../app.js";',
	"local.d.ts": "declare const fromLocalDeclarations: Missing;",
	"node_modules/pkg/package.json": '{"name":"pkg","types":"index.d.ts"}',
	"node_modules/pkg/index.d.ts":
		"export declare const shape: { size: number; broken: NotAType };",
};

const isSource = (file: string) =>
	!file.endsWith(".d.ts") &&
	!file.split(sep).includes("node_modules") &&
	!file.split(sep).includes("test");

const variants: Record<string, ts.CompilerOptions> = {
	strict: { strict: true, skipLibCheck: false },
	skipLibCheck: { strict: true, skipLibCheck: true },
	"no default lib": { strict: true, noLib: true },
};

function program(options: ts.CompilerOptions): ts.Program {
	return ts.createProgram(
		["app.ts", "helper.ts", "test/app.test.ts", "local.d.ts"].map((file) =>
			join(root, file),
		),
		{
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			types: [],
			noEmit: true,
			...options,
		},
	);
}

const text = (diagnostics: readonly ts.Diagnostic[]) =>
	diagnostics.map(
		(diagnostic) =>
			`${diagnostic.file?.fileName ?? "<global>"}:${diagnostic.start} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
	);

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "hobo-codegen-diagnostics-"));
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

// Each case builds whole programs over the default lib: seconds of CPU on a busy runner.
describe("codegen source diagnostics", { timeout: slow(60_000) }, () => {
	it.each(
		Object.keys(variants),
	)("match a whole-program check filtered to sources (%s)", (variant) => {
		const options = variants[variant] ?? {};
		const whole = program(options);
		// What codegen reported before: check everything, then keep source and file-less diagnostics.
		const expected = [
			...whole.getSyntacticDiagnostics(),
			...whole.getSemanticDiagnostics(),
		].filter(
			(diagnostic) => !diagnostic.file || isSource(diagnostic.file.fileName),
		);
		const actual = sourceDiagnostics(program(options), isSource);
		expect(text(actual)).toEqual(text(expected));
		expect(actual.length).toBeGreaterThan(0);
	});

	it("never type-checks a file it does not report on", () => {
		const real = program(variants.strict ?? {});
		const asked: (string | undefined)[] = [];
		const recording = new Proxy(real, {
			get(target, key, receiver) {
				if (key === "getSemanticDiagnostics")
					return (file?: ts.SourceFile) => {
						asked.push(file?.fileName);
						return target.getSemanticDiagnostics(file);
					};
				const value = Reflect.get(target, key, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		sourceDiagnostics(recording, isSource);
		expect(asked.sort()).toEqual(
			["app.ts", "helper.ts"].map((file) => join(root, file)),
		);
	});

	it("reports the same source errors through the engine, and none from declarations or tests", async () => {
		await writeFile(
			join(root, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					types: [],
				},
			}),
		);
		try {
			const failure = createTypeScriptProjectCodegenEngine().generate(root);
			await expect(failure).rejects.toMatchObject({
				code: "HOBO_CODEGEN_SOURCE_PARSE",
			});
			const message = await failure.catch((error: Error) => error.message);
			expect(message).toContain(`${join(root, "app.ts")}:3:14 TS2322`);
			expect(message).toContain(`${join(root, "helper.ts")}:1:54 TS2339`);
			expect(message).not.toContain("node_modules");
			expect(message).not.toContain("local.d.ts");
			expect(message).not.toContain("app.test.ts");
		} finally {
			await rm(join(root, "tsconfig.json"));
		}
	});

	it("parses an installed package's declarations once for every program", () => {
		const options: ts.CompilerOptions = {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			types: [],
		};
		const declaration = join(root, "node_modules/pkg/index.d.ts");
		const parse = () =>
			overlayCompilerHost(options, new Map()).getSourceFile(
				declaration,
				ts.ScriptTarget.ES2022,
			);
		const first = parse();
		expect(first?.fileName).toBe(declaration);
		expect(parse()).toBe(first);
	});
});

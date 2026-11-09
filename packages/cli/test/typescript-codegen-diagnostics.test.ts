import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceDiagnostics } from "../src/codegen/typescript-diagnostics.js";
import {
	createTypeScriptProjectCodegenEngine,
	overlayCompilerHost,
	sourceCandidate,
} from "../src/codegen/typescript-project-engine.js";
import { slow } from "./support/slow.js";

const GENERATED_ROOTS = [
	".hobo/generated/app-imprint",
	"src/_generated/app-imprint",
];

let scratch: string;

const files = {
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
	"node_modules/other/index.d.ts": "export declare const other: 1;",
	"node_modules/third/index.d.ts": "export declare const third: 3;",
} satisfies Record<string, string>;

async function project(
	overrides: Readonly<Record<string, string>> = {},
): Promise<string> {
	const root = await mkdtemp(join(scratch, "project-"));
	for (const [path, content] of Object.entries({ ...files, ...overrides })) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	return root;
}

const baseOptions: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	types: [],
	noEmit: true,
};

/** A program as codegen builds one: through its overlay compiler host. */
function program(root: string, options: ts.CompilerOptions): ts.Program {
	const settings = { ...baseOptions, ...options };
	return ts.createProgram(
		["app.ts", "helper.ts", "test/app.test.ts", "local.d.ts"].map((file) =>
			join(root, file),
		),
		settings,
		overlayCompilerHost(settings, new Map()),
	);
}

const isSourceOf = (root: string) => (file: string) =>
	sourceCandidate(root, file, GENERATED_ROOTS);

const text = (diagnostics: readonly ts.Diagnostic[]) =>
	diagnostics.map(
		(diagnostic) =>
			`${diagnostic.file?.fileName ?? "<global>"}:${diagnostic.start} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
	);

const es2017 = { strict: true, lib: ["lib.es2017.d.ts"] };

// Each row's test file is not a source, so its own errors are never reported,
// but a global type its syntax needs and the lib lacks (TS2318) always was.
const cases = [
	{ name: "strict", options: { strict: true, skipLibCheck: false } },
	{ name: "skipLibCheck", options: { strict: true, skipLibCheck: true } },
	{ name: "no default lib", options: { strict: true, noLib: true } },
	{
		name: "an async generator in a test file, es2017 lib",
		options: es2017,
		test: "export async function* numbers() { yield 1; }",
		global: true,
	},
	{
		name: "`using` in a test file, es2017 lib",
		options: es2017,
		test: "export function scoped() { using held = { [Symbol.dispose]() {} } as never; }",
		global: true,
	},
	{
		name: "`await using` in a test file, es2017 lib",
		options: es2017,
		test: "export async function scoped() { await using held = {} as never; }",
		global: true,
	},
];

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "hobo-codegen-diagnostics-"));
});

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

// Each case builds whole programs over the default lib: seconds of CPU on a busy runner.
describe("codegen source diagnostics", { timeout: slow(60_000) }, () => {
	it.each(
		cases,
	)("match a whole-program check filtered to sources ($name)", async ({
		options,
		test,
		global,
	}) => {
		const root = await project(
			test === undefined ? {} : { "test/app.test.ts": test },
		);
		const isSource = isSourceOf(root);
		const whole = program(root, options);
		// What codegen reported before: check everything, then keep source and file-less diagnostics.
		const expected = [
			...whole.getSyntacticDiagnostics(),
			...whole.getSemanticDiagnostics(),
		].filter(
			(diagnostic) => !diagnostic.file || isSource(diagnostic.file.fileName),
		);
		const actual = sourceDiagnostics(program(root, options), isSource);
		expect(text(actual)).toEqual(text(expected));
		expect(actual.length).toBeGreaterThan(0);
		if (global)
			expect(
				actual.some(
					(diagnostic) => !diagnostic.file && diagnostic.code === 2318,
				),
			).toBe(true);
	});

	it("never type-checks a declaration file", async () => {
		const root = await project();
		const real = program(root, { strict: true, skipLibCheck: false });
		const asked: (string | undefined)[] = [];
		// Program methods are closures over the program, so a copy with one
		// method replaced records what is asked of it.
		const recording: ts.Program = {
			...real,
			getSemanticDiagnostics(file) {
				asked.push(file?.fileName);
				return real.getSemanticDiagnostics(file);
			},
		};
		sourceDiagnostics(recording, isSourceOf(root));
		expect(asked.sort()).toEqual(
			["app.ts", "helper.ts", "test/app.test.ts"].map((file) =>
				join(root, file),
			),
		);
	});

	it("reports the same source errors through the engine, and none from declarations or tests", async () => {
		const root = await project({
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					types: [],
				},
			}),
		});
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
	});

	it("parses an installed package's declarations once for every program", async () => {
		const root = await project();
		const declaration = join(root, "node_modules/pkg/index.d.ts");
		const parse = () =>
			overlayCompilerHost(baseOptions, new Map()).getSourceFile(
				declaration,
				ts.ScriptTarget.ES2022,
			);
		const first = parse();
		expect(first?.fileName).toBe(declaration);
		expect(parse()).toBe(first);
	});
});

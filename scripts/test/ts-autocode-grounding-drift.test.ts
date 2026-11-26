/**
 * Grounding drift gate for the ts-autocode submodule (ADR-0128, ADR-0169).
 *
 * `@hobo/runtime` registers what ts-autocode-grounding composes
 * (`GroundingOptions`) as its own `TrainingOptions`, and hands grounding the
 * decorator metadata it reads (packages/runtime/src/training/granular.ts). A
 * cast or a copy that lets an upstream change through registers a trainable
 * whose identity silently falls back to the function's own name, whose intent
 * is undefined, or without a field grounding added. This test compiles
 * granular.ts with the runtime package's own compiler options against the
 * pinned grounding source, as it is and then with each change below made in
 * memory. These must stop granular.ts compiling (DRIFTS): `methodRef` or
 * `intent` renamed or made optional; `contract.ref` or `params` retyped;
 * `methodRef`, `intent`, `contract.ref`, `params`' values, `contract.input`'s
 * values, `contract.output`, a field description's `description`, the output
 * or its `returns` retyped to `any`; a field description's `example` removed; a field added, by name or by symbol,
 * to the options, the contract, the output or a field description; the
 * output's `returns`, or `params`' values, typed as a field description with
 * a field added; `params` or `contract.input` keyed by symbols too; a
 * declared shape given a field that is not JSON (on the shape descriptor, or
 * on `contract.input`'s values) or a symbol key (on the shape descriptor, on
 * `contract.input`'s values, on an object one field down, on one member of a
 * union, as the shape descriptor or as `contract.output`, or, required or
 * optional, on the shape a type-alias shape descriptor holds of itself); and
 * either metadata parameter retyped.
 * These must not (STILL_COMPILES), since they drop nothing: a shape field
 * holding an array of a type-alias shape, a type-alias shape descriptor that
 * holds itself in an array, or beside `null`, or through a second alias, a
 * JSON field added to `contract.input`'s values only, and the output's
 * `returns` or `params`' values typed as a union with a field description
 * that has no `example`. The test needs the submodule checked out
 * (`pnpm run pins:fetch ts-autocode`), not built.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import ts from "typescript";

const root = join(import.meta.dirname, "../..");
const GROUNDING = join(root, "external/ts-autocode/packages/grounding/src");
const RUNTIME = join(root, "packages/runtime");
const GRANULAR = join(RUNTIME, "src/training/granular.ts");

interface Drift {
	readonly name: string;
	/** A file of ts-autocode-grounding's `src/`. */
	readonly file: string;
	/** Text that occurs exactly once in that file at the pin. */
	readonly from: string;
	readonly to: string;
	/** Text put at the head of the file with the change, such as a declaration it uses. */
	readonly preamble?: string;
}

const OPTIONS_HEAD = "export interface GroundingOptions {\n";
const DESCRIPTOR_HEAD = "export interface ShapeDescriptor {\n";
/** The shape descriptor written as a type alias, which, unlike the interface, may refer to itself and still be JSON. */
const ALIAS_HEAD = "export type ShapeDescriptor = {\n";
const OUTPUT = "\treadonly output?: { readonly returns: FieldDescription };";
const OPTIONS_TAIL = `${OUTPUT}\n}`;
const CONTRACT_TAIL = "\t\treadonly output?: ShapeDescriptor;\n\t};";
const FIELD_TAIL = "\treadonly example?: unknown;\n}";
const PARAMS = "\treadonly params?: Record<string, FieldDescription>;";
const INPUT = "\t\treadonly input?: Readonly<Record<string, ShapeDescriptor>>;";
/** A symbol a drift keys a field by, as upstream would declare one. */
const SYMBOL_KEY = "export declare const GROUNDED: unique symbol;\n";

const DRIFTS: readonly Drift[] = [
	{
		name: "methodRef renamed",
		file: "decorators.ts",
		from: `${OPTIONS_HEAD}\treadonly methodRef: string;`,
		to: `${OPTIONS_HEAD}\treadonly id: string;`,
	},
	{
		name: "methodRef optional",
		file: "decorators.ts",
		from: `${OPTIONS_HEAD}\treadonly methodRef: string;`,
		to: `${OPTIONS_HEAD}\treadonly methodRef?: string;`,
	},
	{
		name: "intent renamed",
		file: "decorators.ts",
		from: "\treadonly intent: string;\n\treadonly contract: {",
		to: "\treadonly purpose: string;\n\treadonly contract: {",
	},
	{
		name: "intent optional",
		file: "decorators.ts",
		from: "\treadonly intent: string;\n\treadonly contract: {",
		to: "\treadonly intent?: string;\n\treadonly contract: {",
	},
	{
		name: "contract.ref retyped",
		file: "decorators.ts",
		from: "\treadonly contract: {\n\t\treadonly ref: string;",
		to: "\treadonly contract: {\n\t\treadonly ref: number;",
	},
	{
		name: "params retyped",
		file: "decorators.ts",
		from: "\treadonly params?: Record<string, FieldDescription>;\n\treadonly output?",
		to: "\treadonly params?: Record<string, string>;\n\treadonly output?",
	},
	{
		name: "methodRef retyped to any",
		file: "decorators.ts",
		from: `${OPTIONS_HEAD}\treadonly methodRef: string;`,
		to: `${OPTIONS_HEAD}\treadonly methodRef: any;`,
	},
	{
		name: "intent retyped to any",
		file: "decorators.ts",
		from: "\treadonly intent: string;\n\treadonly contract: {",
		to: "\treadonly intent: any;\n\treadonly contract: {",
	},
	{
		name: "contract.ref retyped to any",
		file: "decorators.ts",
		from: "\treadonly contract: {\n\t\treadonly ref: string;",
		to: "\treadonly contract: {\n\t\treadonly ref: any;",
	},
	{
		name: "the output retyped to any",
		file: "decorators.ts",
		from: OUTPUT,
		to: "\treadonly output?: any;",
	},
	{
		name: "the output's returns retyped to any",
		file: "decorators.ts",
		from: OUTPUT,
		to: "\treadonly output?: { readonly returns: any };",
	},
	{
		name: "params' values retyped to any",
		file: "decorators.ts",
		from: PARAMS,
		to: "\treadonly params?: Record<string, any>;",
	},
	{
		name: "contract.input's values retyped to any",
		file: "decorators.ts",
		from: INPUT,
		to: "\t\treadonly input?: Readonly<Record<string, any>>;",
	},
	{
		name: "contract.output retyped to any",
		file: "decorators.ts",
		from: CONTRACT_TAIL,
		to: "\t\treadonly output?: any;\n\t};",
	},
	{
		name: "a field description's description retyped to any",
		file: "decorators.ts",
		from: "export interface FieldDescription {\n\treadonly description: string;",
		to: "export interface FieldDescription {\n\treadonly description: any;",
	},
	{
		name: "a shape descriptor field that is not JSON",
		file: "decorators.ts",
		from: `${DESCRIPTOR_HEAD}\treadonly type: string;`,
		to: `${DESCRIPTOR_HEAD}\treadonly type: string;\n\treadonly validate: (value: unknown) => boolean;`,
	},
	{
		name: "a field is added to the options",
		file: "decorators.ts",
		from: OPTIONS_TAIL,
		to: OPTIONS_TAIL.replace(
			"\n}",
			"\n\treadonly rubric: Readonly<Record<string, number>>;\n}",
		),
	},
	{
		name: "an optional field is added to the options",
		file: "decorators.ts",
		from: OPTIONS_TAIL,
		to: OPTIONS_TAIL.replace(
			"\n}",
			"\n\treadonly rubric?: Readonly<Record<string, number>>;\n}",
		),
	},
	{
		name: "a field is added to the contract",
		file: "decorators.ts",
		from: CONTRACT_TAIL,
		to: CONTRACT_TAIL.replace(
			"\n\t};",
			"\n\t\treadonly examples: readonly unknown[];\n\t};",
		),
	},
	{
		name: "an optional field is added to the contract",
		file: "decorators.ts",
		from: CONTRACT_TAIL,
		to: CONTRACT_TAIL.replace(
			"\n\t};",
			"\n\t\treadonly invariants?: readonly string[];\n\t};",
		),
	},
	{
		name: "a field is added to a field description",
		file: "decorators.ts",
		from: FIELD_TAIL,
		to: FIELD_TAIL.replace("\n}", "\n\treadonly unit?: string;\n}"),
	},
	{
		name: "a field description's example is removed",
		file: "decorators.ts",
		from: FIELD_TAIL,
		to: "}",
	},
	{
		name: "a symbol-keyed field is added to the options",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: OPTIONS_TAIL,
		to: OPTIONS_TAIL.replace(
			"\n}",
			"\n\treadonly [GROUNDED]: { readonly rubric: number };\n}",
		),
	},
	{
		name: "a symbol-keyed field is added to the contract",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: CONTRACT_TAIL,
		to: CONTRACT_TAIL.replace(
			"\n\t};",
			"\n\t\treadonly [GROUNDED]: readonly string[];\n\t};",
		),
	},
	{
		name: "a symbol-keyed field is added to a field description",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: FIELD_TAIL,
		to: FIELD_TAIL.replace("\n}", "\n\treadonly [GROUNDED]?: string;\n}"),
	},
	{
		name: "a symbol-keyed field is added to a shape descriptor",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: `${DESCRIPTOR_HEAD}\treadonly type: string;`,
		to: `${DESCRIPTOR_HEAD}\treadonly type: string;\n\treadonly [GROUNDED]: string;`,
	},
	{
		name: "a field is added to the output",
		file: "decorators.ts",
		from: OUTPUT,
		to: "\treadonly output?: { readonly returns: FieldDescription; readonly throws?: FieldDescription };",
	},
	{
		name: "a symbol-keyed field is added to the output",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: OUTPUT,
		to: "\treadonly output?: { readonly returns: FieldDescription; readonly [GROUNDED]: string };",
	},
	{
		name: "the output's returns holds a field description with a field added",
		file: "decorators.ts",
		from: OUTPUT,
		to: "\treadonly output?: { readonly returns: FieldDescription & { readonly unit: string } };",
	},
	{
		name: "params holds a field description subtype with a field added",
		file: "decorators.ts",
		preamble:
			"export interface ParamDescription extends FieldDescription {\n\treadonly unit?: string;\n}\n",
		from: PARAMS,
		to: "\treadonly params?: Record<string, ParamDescription>;",
	},
	{
		name: "params is keyed by symbols too",
		file: "decorators.ts",
		from: PARAMS,
		to: "\treadonly params?: Record<PropertyKey, FieldDescription>;",
	},
	{
		name: "contract.input is keyed by symbols too",
		file: "decorators.ts",
		from: INPUT,
		to: "\t\treadonly input?: Readonly<Record<PropertyKey, ShapeDescriptor>>;",
	},
	{
		name: "contract.input holds shapes with a field that is not JSON",
		file: "decorators.ts",
		from: INPUT,
		to: "\t\treadonly input?: Readonly<Record<string, ShapeDescriptor & { readonly validate: (value: unknown) => boolean }>>;",
	},
	{
		name: "contract.input holds shapes with a symbol-keyed field",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: INPUT,
		to: "\t\treadonly input?: Readonly<Record<string, ShapeDescriptor & { readonly [GROUNDED]: string }>>;",
	},
	{
		name: "a shape descriptor is a union with a symbol-keyed member",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: DESCRIPTOR_HEAD,
		to: `export type ShapeDescriptor = ShapeBase | (ShapeBase & { readonly [GROUNDED]: string });\nexport interface ShapeBase {\n`,
	},
	{
		name: "a shape descriptor field holds an object with a symbol key",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: `${DESCRIPTOR_HEAD}\treadonly type: string;`,
		to: `${DESCRIPTOR_HEAD}\treadonly type: string;\n\treadonly items?: { readonly [GROUNDED]: string };`,
	},
	{
		name: "contract.output is a union with a symbol-keyed member",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: CONTRACT_TAIL,
		to: "\t\treadonly output?: ShapeDescriptor | { readonly type: string; readonly [GROUNDED]: string };\n\t};",
	},
	{
		name: "a type-alias shape descriptor holds itself with a symbol key added",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: `${DESCRIPTOR_HEAD}\treadonly type: string;`,
		to: `${ALIAS_HEAD}\treadonly type: string;\n\treadonly child?: ShapeDescriptor & { readonly [GROUNDED]: string };`,
	},
	{
		name: "a type-alias shape descriptor holds itself with an optional symbol key added",
		file: "decorators.ts",
		preamble: SYMBOL_KEY,
		from: `${DESCRIPTOR_HEAD}\treadonly type: string;`,
		to: `${ALIAS_HEAD}\treadonly type: string;\n\treadonly child?: ShapeDescriptor & { readonly [GROUNDED]?: string };`,
	},
	{
		name: "granularOptionsFor's metadata parameter retyped",
		file: "decorators.ts",
		from: "\tmetadata: Record<PropertyKey, unknown> | undefined,\n\tmethodName: string,",
		to: "\tmetadata: ReadonlyMap<string, unknown> | undefined,\n\tmethodName: string,",
	},
	{
		name: "finalizeTrainableClass's metadata parameter retyped",
		file: "component.ts",
		from: "\tmetadata: Record<PropertyKey, unknown> | undefined,\n\tregistry: GroundingRegistry,",
		to: "\tmetadata: ReadonlyMap<string, unknown> | undefined,\n\tregistry: GroundingRegistry,",
	},
];

/**
 * Upstream changes that drop nothing, so granular.ts must still compile with
 * each: the checks above must not refuse a JSON shape for being recursive or
 * holding arrays, a field that only one place adds, nor a field description
 * that has no example.
 */
const STILL_COMPILES: readonly Drift[] = [
	{
		name: "a shape descriptor field holds an array of a type-alias shape",
		file: "decorators.ts",
		preamble:
			"export type ShapeItem = { readonly type: string; readonly description?: string };\n",
		from: `${DESCRIPTOR_HEAD}\treadonly type: string;`,
		to: `${DESCRIPTOR_HEAD}\treadonly type: string;\n\treadonly items?: ShapeItem[];`,
	},
	{
		name: "the shape descriptor is a type alias that refers to itself",
		file: "decorators.ts",
		from: `${DESCRIPTOR_HEAD}\treadonly type: string;`,
		to: `${ALIAS_HEAD}\treadonly type: string;\n\treadonly items?: ShapeDescriptor[];`,
	},
	{
		name: "the shape descriptor is a type alias that holds itself or null",
		file: "decorators.ts",
		from: `${DESCRIPTOR_HEAD}\treadonly type: string;`,
		to: `${ALIAS_HEAD}\treadonly type: string;\n\treadonly parent?: ShapeDescriptor | null;`,
	},
	{
		name: "the shape descriptor and a second type alias refer to each other",
		file: "decorators.ts",
		preamble:
			"export type ShapeFields = { readonly [name: string]: ShapeDescriptor };\n",
		from: `${DESCRIPTOR_HEAD}\treadonly type: string;`,
		to: `${ALIAS_HEAD}\treadonly type: string;\n\treadonly fields?: ShapeFields;`,
	},
	{
		name: "contract.input holds shapes with a JSON field added",
		file: "decorators.ts",
		from: INPUT,
		to: "\t\treadonly input?: Readonly<Record<string, ShapeDescriptor & { readonly format?: string }>>;",
	},
	{
		name: "the output's returns is a union with a field description that has no example",
		file: "decorators.ts",
		from: OUTPUT,
		to: "\treadonly output?: { readonly returns: FieldDescription | { readonly description: string } };",
	},
	{
		name: "params' values are a union with a field description that has no example",
		file: "decorators.ts",
		from: PARAMS,
		to: "\treadonly params?: Record<string, FieldDescription | { readonly description: string }>;",
	},
];

/** The runtime package's compiler options, with ts-autocode-grounding read from its source. */
function runtimeOptions(): ts.CompilerOptions {
	const parsed = ts.getParsedCommandLineOfConfigFile(
		join(RUNTIME, "tsconfig.json"),
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(
					ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
				);
			},
		},
	);
	assert.ok(parsed, "packages/runtime/tsconfig.json parses");
	// Nothing is emitted, so the output layout (rootDir, which grounding's
	// source sits outside of) does not apply; every checking option does.
	const {
		rootDir: _rootDir,
		outDir: _outDir,
		declaration: _declaration,
		sourceMap: _sourceMap,
		...checking
	} = parsed.options;
	return {
		...checking,
		noEmit: true,
		paths: { "ts-autocode-grounding": [join(GROUNDING, "index.ts")] },
	};
}

/** A file of grounding's `src/` and the text a compile reads in its place. */
interface Replaced {
	readonly file: string;
	readonly text: string;
}

interface Compiled {
	/** granular.ts's diagnostics, one line each. */
	readonly messages: readonly string[];
	readonly program: ts.Program;
}

/** granular.ts's diagnostics, with grounding's `src/<file>` replaced by `text` when given. */
function granularDiagnostics(
	options: ts.CompilerOptions,
	replaced?: Replaced,
	oldProgram?: ts.Program,
): Compiled {
	const host = ts.createCompilerHost(options, true);
	if (replaced !== undefined) {
		const target = join(GROUNDING, replaced.file);
		const getSourceFile = host.getSourceFile.bind(host);
		const readFile = host.readFile.bind(host);
		host.getSourceFile = (fileName, language, onError, shouldCreate) =>
			resolve(fileName) === target
				? ts.createSourceFile(fileName, replaced.text, language, true)
				: getSourceFile(fileName, language, onError, shouldCreate);
		host.readFile = (fileName) =>
			resolve(fileName) === target ? replaced.text : readFile(fileName);
	}
	const program = ts.createProgram([GRANULAR], options, host, oldProgram);
	const source = program.getSourceFile(GRANULAR);
	assert.ok(source, "granular.ts is part of the program");
	const messages = [
		...program.getSyntacticDiagnostics(source),
		...program.getSemanticDiagnostics(source),
	].map((diagnostic) => {
		const at =
			diagnostic.start === undefined
				? ""
				: `:${source.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
		return `granular.ts${at} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
	});
	return { messages, program };
}

/** The text of grounding's `src/<file>` with `drift` made, once the text it changes is there exactly once. */
function drifted(drift: Drift): Replaced {
	const text = readFileSync(join(GROUNDING, drift.file), "utf8");
	assert.equal(
		text.split(drift.from).length,
		2,
		`grounding's src/${drift.file} no longer holds the text this change makes exactly once; update the change to the new source`,
	);
	return {
		file: drift.file,
		text: (drift.preamble ?? "") + text.replace(drift.from, drift.to),
	};
}

describe("ts-autocode grounding drift", () => {
	it("the submodule is checked out at its pin", () => {
		assert.ok(
			existsSync(join(GROUNDING, "decorators.ts")),
			"external/ts-autocode is not checked out: run `pnpm run pins:fetch ts-autocode`",
		);
	});

	const options = runtimeOptions();
	const pinned = granularDiagnostics(options);

	it("granular.ts compiles against the pinned grounding source", () => {
		assert.deepEqual(pinned.messages, []);
	});

	for (const drift of DRIFTS) {
		it(`granular.ts stops compiling when ${drift.name}`, () => {
			const { messages } = granularDiagnostics(
				options,
				drifted(drift),
				pinned.program,
			);
			assert.notDeepEqual(
				messages,
				[],
				`granular.ts still compiles when ${drift.name}`,
			);
		});
	}

	for (const change of STILL_COMPILES) {
		it(`granular.ts still compiles when ${change.name}`, () => {
			const { messages } = granularDiagnostics(
				options,
				drifted(change),
				pinned.program,
			);
			assert.deepEqual(messages, []);
		});
	}
});

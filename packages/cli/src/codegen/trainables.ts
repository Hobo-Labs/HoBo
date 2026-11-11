import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import { create } from "@bufbuild/protobuf";
import { generateDeclaredRegistrations } from "ts-autocode-grounding";
import type { discoverInSource } from "ts-autocode-training";
import type { AmbientTrainableClass } from "./ambient-trainables.js";
import type {
	SourceModel,
	SourceModelBindle,
	SourceModelResource,
} from "./engine.js";
import { isPlainIdentifier, isReservedWord } from "./identifiers.js";
import {
	emittedPath,
	preservesJsx,
	projectPath,
	scannedSources,
} from "./source-files.js";
import {
	type CodegenArtifact,
	CodegenArtifactSchema,
	CodegenError,
	type CodegenLayout,
	type TrainableStub,
	TrainableStubSchema,
} from "./types.js";

// Trainable codegen (ADR-0125 / generated-stack.md). Generated here:
// contract-backed `training.define()` stubs for every bindle step (a semantic
// function until promotion); inferred `training.infer()` registrations for
// bare `"use training"` markers found in authored source (syntax 3 — the
// marker carries no bindings; codegen generates them); and, for an ambient
// `@trainable declare class` (Plan 2 Syntax 0), the `defineGrounding(...)`
// registrations ts-autocode-grounding's emitter writes (ADR-0128), one module
// per class beside the trainables module, re-exported from it (the classes
// come from ambient-trainables.ts). Output paths
// and module specifiers all come from the layout config; record shapes are
// the generated hobo.cli.v1 proto types.

/** An exported function carrying the bare `"use training"` prologue. */
export interface DirectiveFunction {
	readonly name: string;
	/** Project-relative source file (posix separators). */
	readonly file: string;
	/** The project-relative file TypeScript emits it to, which the trainables module imports. */
	readonly emitted: string;
}

type DiscoverInSource = typeof discoverInSource;

/**
 * The directive is a prologue (first statement of the function body).
 * Discovery delegates to ts-autocode-training's AST walk (ADR-0128):
 * exported free functions whose first statement is the `"use training"`
 * string literal — robust against brace-bearing parameter/return type
 * annotations, comments, and directive-like strings elsewhere.
 */
function directiveFunctionNames(
	discover: DiscoverInSource,
	source: string,
): readonly string[] {
	const names = new Set<string>();
	for (const target of discover(source)) {
		if (target.className === undefined && target.exported) {
			names.add(target.methodName);
		}
	}
	return [...names];
}

/**
 * Scan the layout's source dir for `"use training"`-marked exported
 * functions (deterministic file order; generated roots excluded), each with
 * the file TypeScript emits it to. The project's `tsconfig.json` decides that
 * for a `.tsx` file only, so it is read only once a `.tsx` file holds one.
 */
export async function scanTrainableDirectives(
	projectRoot: string,
	layout: CodegenLayout,
): Promise<readonly DirectiveFunction[]> {
	const found: DirectiveFunction[] = [];
	let preserveJsx: boolean | undefined;
	let discover: DiscoverInSource | undefined;
	for (const path of await scannedSources(projectRoot, layout)) {
		const source = await readFile(path, "utf8");
		// The training stack (~1,300 modules, ~1.4 s) loads on the first file a
		// scan reads, not when @hobo/cli is imported: every `hobo` process imports
		// the CLI, and only codegen, build and stub reach this scan.
		discover ??= (await import("ts-autocode-training")).discoverInSource;
		const names = directiveFunctionNames(discover, source);
		if (names.length === 0) continue;
		if (path.endsWith(".tsx")) preserveJsx ??= preservesJsx(projectRoot);
		const file = projectPath(projectRoot, path);
		const emitted = emittedPath(file, preserveJsx === true);
		for (const name of names) found.push({ name, file, emitted });
	}
	return found;
}

export interface TrainablesBuild {
	readonly artifact: CodegenArtifact;
	/** One registration module per ambient @trainable class, beside `artifact`. */
	readonly declaredArtifacts: readonly CodegenArtifact[];
	readonly stubs: readonly TrainableStub[];
}

interface TrainableStepEntry {
	readonly stub: TrainableStub;
	readonly code: string;
}

interface TrainableDirectiveEntry extends TrainableStepEntry {
	readonly importLine: string;
}

export function buildTrainables(
	model: SourceModel,
	layout: CodegenLayout,
	directives: readonly DirectiveFunction[] = [],
	ambient: readonly AmbientTrainableClass[] = [],
): TrainablesBuild {
	const stepEntries = model.bindles.flatMap((bindle) =>
		bindle.steps.map((step) => toStepEntry(model, bindle, step)),
	);
	const directiveEntries = directives.map((directive) =>
		toDirectiveEntry(directive, layout),
	);
	const declaredModules = ambient.map((entry) =>
		toDeclaredModule(entry, layout),
	);
	const declaredEntries = declaredModules.flatMap((module) => module.entries);
	const entries = [...stepEntries, ...directiveEntries];
	const stubs = [...entries, ...declaredEntries].map((entry) => entry.stub);
	const usedTypes = [
		...new Set(stepEntries.map((entry) => entry.stub.typeName)),
	].sort();
	refuseUnusableExports(
		stubs,
		moduleBindings(layout.imports.runtimeModule, usedTypes, directives),
	);

	const header =
		`// Generated by hobo codegen — do not edit.\n` +
		`// Trainable bindings (ADR-0125): contract-backed training.define() stubs\n` +
		`// per bindle step, plus inferred training.infer() registrations generated\n` +
		`// from bare "use training" markers in authored source. Stubs serve their\n` +
		`// contract example until a training artifact is applied\n` +
		`// (applyTrainingArtifact) and can be reverted with null.\n` +
		`import { training } from ${JSON.stringify(layout.imports.runtimeModule)};\n` +
		(usedTypes.length > 0
			? `import type { ${usedTypes.join(", ")} } from ${JSON.stringify(layout.imports.bindingsSpecifier)};\n`
			: "") +
		directiveEntries.map((entry) => entry.importLine).join("");

	const defines = entries.map((entry) => entry.code).join("\n");
	const reexports =
		declaredEntries.length > 0
			? `\n// Ambient @trainable classes: their registrations are generated beside\n` +
				`// this module (declared/<Class>.ts) and re-exported here, so importing it\n` +
				`// registers them.\n` +
				declaredEntries.map((entry) => entry.reexport).join("")
			: "";

	const manifest =
		`export const trainableStubs = [\n` +
		`${stubs
			.map(
				(stub) =>
					`  { methodRef: ${JSON.stringify(stub.methodRef)}, exportName: ${JSON.stringify(stub.exportName)}, origin: ${JSON.stringify(stub.origin)}, contractRef: ${JSON.stringify(stub.contractRef)} },`,
			)
			.join("\n")}\n` +
		`] as const;\n`;

	return {
		artifact: create(CodegenArtifactSchema, {
			path: layout.files.trainables,
			content: `${header}\n${defines}${reexports}\n${manifest}`,
		}),
		declaredArtifacts: declaredModules.map((module) => module.artifact),
		stubs,
	};
}

/**
 * What the trainables module binds besides its exports' own names, each with
 * what binds it: the runtime's `training` import, the `trainableStubs`
 * manifest, the bindings' type imports, and one import per bare
 * `"use training"` function under its own name. A directive whose name another
 * of these already binds would be a duplicate binding (TS2300), so it is
 * refused here, named with the file it is in.
 */
function moduleBindings(
	runtimeModule: string,
	usedTypes: readonly string[],
	directives: readonly DirectiveFunction[],
): ReadonlyMap<string, string> {
	const bound = new Map<string, string>([
		["training", `the training import from ${runtimeModule}`],
		["trainableStubs", "the trainableStubs manifest"],
		...usedTypes.map((type): [string, string] => [
			type,
			`the ${type} type import`,
		]),
	]);
	for (const { name, file } of directives) {
		const earlier = bound.get(name);
		if (earlier !== undefined) {
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				`The "use training" function ${name} in ${file} would be imported into the trainables module as ${name}, which ${earlier} already binds; rename the function`,
				{ name, file },
			);
		}
		bound.set(name, `the import of ${name} from ${file}`);
	}
	return bound;
}

/**
 * Every export of the trainables module must compile: an identifier that is
 * not a reserved word (`$.$` camelCases to ""), not a name the module already
 * binds (its `training` and type imports, a directive's import, the
 * `trainableStubs` manifest: `Trainable.Stubs` camelCases to that), and not one
 * another entry exports (`Incident.classify` and the step `incident.classify`
 * both camelCase to `incidentClassify`).
 */
function refuseUnusableExports(
	stubs: readonly TrainableStub[],
	bound: ReadonlyMap<string, string>,
): void {
	const seen = new Map<string, string>();
	for (const { exportName, methodRef } of stubs) {
		const unusable = !isPlainIdentifier(exportName)
			? "which is not an identifier"
			: isReservedWord(exportName)
				? "which is a reserved word"
				: undefined;
		if (unusable !== undefined) {
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				`Trainable ${methodRef} generates the export name ${JSON.stringify(exportName)}, ${unusable}`,
				{ exportName, methodRef },
			);
		}
		const binding = bound.get(exportName);
		if (binding !== undefined) {
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				`Trainable ${methodRef} generates the export ${exportName}, which the trainables module already binds (${binding})`,
				{ exportName, methodRef },
			);
		}
		const earlier = seen.get(exportName);
		if (earlier !== undefined) {
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				`Trainables ${earlier} and ${methodRef} both generate the export ${exportName}`,
				{ exportName, methodRefs: [earlier, methodRef] },
			);
		}
		seen.set(exportName, methodRef);
	}
}

function toStepEntry(
	model: SourceModel,
	bindle: SourceModelBindle,
	step: string,
): TrainableStepEntry {
	const resource =
		model.resources.find((candidate) =>
			step.startsWith(`${candidate.name}.`),
		) ?? model.resources[0];
	if (!resource) {
		throw new Error(`no resource available for bindle step "${step}"`);
	}

	const stub = create(TrainableStubSchema, {
		methodRef: step,
		exportName: camelCase(step),
		resource: resource.name,
		typeName: resource.typeName,
		contractRef: `bindle://${bindle.name}/steps/${step}`,
		origin: "bindle-step",
	});

	const example = exampleLiteral(resource);
	const code =
		`export const ${stub.exportName} = training.define<${resource.typeName}, ${resource.typeName}>({\n` +
		`  methodRef: ${JSON.stringify(step)},\n` +
		`  intent: ${JSON.stringify(
			`Implement bindle step "${step}" over resource "${resource.name}" (${bindle.provider} provider).`,
		)},\n` +
		`  contract: {\n` +
		`    ref: ${JSON.stringify(stub.contractRef)},\n` +
		`    examples: [{ input: ${example}, output: ${example} }],\n` +
		`  },\n` +
		`  rubric: { exactMatch: 1 },\n` +
		`});\n`;

	return { stub, code };
}

function toDirectiveEntry(
	directive: DirectiveFunction,
	layout: CodegenLayout,
): TrainableDirectiveEntry {
	const stub = create(TrainableStubSchema, {
		methodRef: directive.name,
		exportName: `${directive.name}Training`,
		contractRef: `inferred://${directive.name}`,
		origin: "directive",
	});

	const fromDir = posix.dirname(layout.files.trainables);
	const specifier = posix
		.relative(fromDir, directive.emitted)
		.replace(/^(?!\.)/, "./");

	return {
		stub,
		importLine: `import { ${directive.name} } from ${JSON.stringify(specifier)};\n`,
		code:
			`// Inferred bindings for the bare "use training" marker in ${directive.file}.\n` +
			`export const ${stub.exportName} = training.infer(${directive.name});\n`,
	};
}

interface DeclaredEntry {
	readonly stub: TrainableStub;
	readonly reexport: string;
}

interface DeclaredModule {
	readonly artifact: CodegenArtifact;
	readonly entries: readonly DeclaredEntry[];
}

/**
 * The registration module for one ambient class, written by
 * ts-autocode-grounding's emitter: one `export const <method> =
 * defineGrounding({...})` per operation, `defineGrounding` imported from the
 * layout's runtime module (`@hobo/runtime`'s is `training.define`). Every
 * identity in it is derived from the scanned class and method names. The
 * trainables module re-exports each operation as `<class><Method>`, the
 * camelCase of its methodRef, as a bindle step's stub is named.
 */
function toDeclaredModule(
	ambient: AmbientTrainableClass,
	layout: CodegenLayout,
): DeclaredModule {
	const { declared, file } = ambient;
	const fromDir = posix.dirname(layout.files.trainables);
	const path = posix.join(fromDir, "declared", `${declared.className}.ts`);
	const specifier = `./${posix.relative(fromDir, path).replace(/\.ts$/u, ".js")}`;
	const artifact = create(CodegenArtifactSchema, {
		path,
		content: generateDeclaredRegistrations(declared, {
			runtimeModule: rebased(
				layout.imports.runtimeModule,
				fromDir,
				posix.dirname(path),
			),
			// @hobo/runtime's generateDeclaredRegistrations writes this module
			// with this header too (the declared codegen test holds them equal).
			header: [
				"// Generated by hobo codegen — do not edit.",
				`// Registrations for the ambient @trainable class ${declared.className} in ${file}`,
				"// (Plan 2 Syntax 0, ADR-0128): signature-only, served by the stub baseline.",
			],
		}),
	});
	const entries = declared.operations.map((operation) => {
		const stub = create(TrainableStubSchema, {
			methodRef: operation.methodRef,
			exportName: camelCase(operation.methodRef),
			contractRef: operation.contractRef,
			origin: "declared",
		});
		return {
			stub,
			reexport: `export { ${operation.method} as ${stub.exportName} } from ${JSON.stringify(specifier)};\n`,
		};
	});
	return { artifact, entries };
}

/**
 * A module specifier written for a module in `fromDir`, as a module in `toDir`
 * must write it: a relative one is rebased (the layout's runtime module is
 * relative to trainables.ts, a declared module sits one directory below it;
 * `.` and `..` alone are relative too),
 * a bare one is a package name and stays as it is.
 */
function rebased(specifier: string, fromDir: string, toDir: string): string {
	if (!/^\.\.?(?:\/|$)/u.test(specifier)) return specifier;
	const target = posix.relative(toDir, posix.join(fromDir, specifier));
	return target.startsWith(".") ? target : `./${target}`;
}

/** The deterministic example object literal for a resource's fields. */
function exampleLiteral(resource: SourceModelResource): string {
	if (resource.example !== undefined) return JSON.stringify(resource.example);
	const fields = resource.fields
		.filter((field) => field.example !== undefined)
		.map(
			(field) =>
				`${JSON.stringify(field.name)}: ${JSON.stringify(field.example)}`,
		)
		.join(", ");
	return `{ ${fields} }`;
}

function camelCase(value: string): string {
	const parts = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
	return parts
		.map((part, index) =>
			index === 0
				? part.charAt(0).toLowerCase() + part.slice(1)
				: part.charAt(0).toUpperCase() + part.slice(1),
		)
		.join("");
}

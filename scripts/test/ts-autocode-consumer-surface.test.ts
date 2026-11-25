import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

import ts from "typescript";

const root = join(import.meta.dirname, "../..");
const SUBMODULE = "external/ts-autocode";
const NOT_CHECKED_OUT = `${SUBMODULE} is not checked out: run \`pnpm run pins:fetch ts-autocode\``;
const SPECIFIER = /^(ts-autocode(?:-[a-z]+)?)(?:\/(.+))?$/u;
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/u;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "_generated"]);
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

interface ImportedName {
	readonly file: string;
	readonly specifier: string;
	readonly packageName: string;
	readonly entryPoint: string;
	readonly name: string;
	readonly typeOnly: boolean;
}

interface PackageEntry {
	readonly directory: string;
	readonly entries: ReadonlyMap<string, string>;
	readonly dependsOn: readonly string[];
}

type Binding = { readonly name: string; readonly typeOnly: boolean };

function packageSources(directory: string): string[] {
	const files: string[] = [];
	for (const item of readdirSync(directory, { withFileTypes: true })) {
		if (SKIPPED_DIRECTORIES.has(item.name) || item.name.startsWith("."))
			continue;
		const path = join(directory, item.name);
		if (item.isDirectory()) {
			files.push(...packageSources(path));
		} else if (
			item.isFile() &&
			SOURCE_FILE.test(item.name) &&
			readFileSync(path, "utf8").includes("ts-autocode")
		) {
			files.push(path);
		}
	}
	return files;
}

function namesIn(
	clause: ts.NamedImportBindings | ts.NamedExportBindings | undefined,
	typeOnly: boolean,
): Binding[] {
	if (clause === undefined) return [{ name: "*", typeOnly }];
	if (ts.isNamespaceImport(clause) || ts.isNamespaceExport(clause))
		return [{ name: "*", typeOnly }];
	return clause.elements.map((element) => ({
		name: (element.propertyName ?? element.name).text,
		typeOnly: typeOnly || element.isTypeOnly,
	}));
}

function declarationBindings(
	statement: ts.ImportDeclaration | ts.ExportDeclaration,
): Binding[] {
	if (ts.isExportDeclaration(statement))
		return namesIn(statement.exportClause, statement.isTypeOnly);
	const clause = statement.importClause;
	if (clause === undefined) return [{ name: "*", typeOnly: false }];
	const bindings = namesIn(clause.namedBindings, clause.isTypeOnly);
	if (clause.name !== undefined)
		bindings.push({ name: "default", typeOnly: clause.isTypeOnly });
	return clause.namedBindings === undefined
		? bindings.filter((binding) => binding.name !== "*")
		: bindings;
}

function dynamicBindings(call: ts.CallExpression): Binding[] {
	const whole: Binding[] = [{ name: "*", typeOnly: false }];
	let node: ts.Node = call;
	let awaited = false;
	while (
		ts.isParenthesizedExpression(node.parent) ||
		ts.isAwaitExpression(node.parent)
	) {
		awaited ||= ts.isAwaitExpression(node.parent);
		node = node.parent;
	}
	if (!awaited) return whole;
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
		return [{ name: parent.name.text, typeOnly: false }];
	if (
		ts.isVariableDeclaration(parent) &&
		parent.initializer === node &&
		ts.isObjectBindingPattern(parent.name)
	) {
		return parent.name.elements.map((element) => {
			const key = element.propertyName ?? element.name;
			return {
				name:
					element.dotDotDotToken === undefined &&
					(ts.isIdentifier(key) || ts.isStringLiteral(key))
						? key.text
						: "*",
				typeOnly: false,
			};
		});
	}
	return whole;
}

function importTypeBindings(node: ts.ImportTypeNode): Binding[] {
	let qualifier = node.qualifier;
	while (qualifier !== undefined && ts.isQualifiedName(qualifier))
		qualifier = qualifier.left;
	return [
		{
			name: qualifier === undefined ? "*" : qualifier.text,
			typeOnly: !node.isTypeOf,
		},
	];
}

function referenceOf(
	node: ts.Node,
): { module: ts.Node | undefined; bindings: () => Binding[] } | undefined {
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
		return {
			module: node.moduleSpecifier,
			bindings: () => declarationBindings(node),
		};
	if (
		ts.isImportEqualsDeclaration(node) &&
		ts.isExternalModuleReference(node.moduleReference)
	)
		return {
			module: node.moduleReference.expression,
			bindings: () => [{ name: "*", typeOnly: node.isTypeOnly }],
		};
	if (
		ts.isCallExpression(node) &&
		node.expression.kind === ts.SyntaxKind.ImportKeyword
	)
		return { module: node.arguments[0], bindings: () => dynamicBindings(node) };
	if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
		return {
			module: node.argument.literal,
			bindings: () => importTypeBindings(node),
		};
	return undefined;
}

function importsOf(path: string): ImportedName[] {
	return importsIn(readFileSync(path, "utf8"), relative(root, path));
}

function importsIn(text: string, file: string): ImportedName[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const found: ImportedName[] = [];
	const visit = (node: ts.Node): void => {
		const reference = referenceOf(node);
		const module = reference?.module;
		if (reference !== undefined && module !== undefined) {
			const match = ts.isStringLiteralLike(module)
				? SPECIFIER.exec(module.text)
				: null;
			const packageName = match?.[1];
			if (match !== null && packageName !== undefined) {
				const entryPoint = match[2] === undefined ? "." : `./${match[2]}`;
				for (const binding of reference.bindings()) {
					found.push({
						file,
						specifier: match[0],
						packageName,
						entryPoint,
						...binding,
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function submodulePackages(): ReadonlyMap<string, PackageEntry> {
	const base = join(root, SUBMODULE, "packages");
	assert.ok(existsSync(base), NOT_CHECKED_OUT);
	const packages = new Map<string, PackageEntry>();
	for (const item of readdirSync(base, { withFileTypes: true })) {
		const manifestPath = join(base, item.name, "package.json");
		if (!item.isDirectory() || !existsSync(manifestPath)) continue;
		const manifest: {
			name?: string;
			exports?: Record<string, { import?: string }>;
		} & Partial<
			Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>
		> = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (manifest.name === undefined) continue;
		const entries = new Map<string, string>();
		for (const [key, target] of Object.entries(manifest.exports ?? {})) {
			const built = target.import;
			if (built === undefined) continue;
			const entry = built
				.replace(/^\.\/dist\//u, "src/")
				.replace(/\.js$/u, ".ts");
			entries.set(key, join(base, item.name, entry));
		}
		const dependsOn = DEPENDENCY_FIELDS.flatMap((field) =>
			Object.keys(manifest[field] ?? {}),
		).filter((name) => SPECIFIER.test(name) && !name.includes("/"));
		packages.set(manifest.name, {
			directory: `${SUBMODULE}/packages/${item.name}`,
			entries,
			dependsOn: [...new Set(dependsOn)],
		});
	}
	return packages;
}

function workspaceMembers(): readonly RegExp[] {
	const members: RegExp[] = [];
	let inPackages = false;
	for (const line of readFileSync(
		join(root, "pnpm-workspace.yaml"),
		"utf8",
	).split("\n")) {
		if (/^\S/u.test(line)) inPackages = line.startsWith("packages:");
		const item = /^\s+-\s+["']?([^"'\s]+)["']?\s*$/u.exec(line);
		if (inPackages && item?.[1] !== undefined) {
			const pattern = item[1]
				.split("*")
				.map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
				.join("[^/]+");
			members.push(new RegExp(`^${pattern}$`, "u"));
		}
	}
	return members;
}

interface ValueProbe {
	readonly path: string;
	readonly text: string;
	readonly names: readonly string[];
	readonly exported: Map<string, boolean>;
}

function valueProbe(
	entry: string,
	index: number,
	exported: Map<string, boolean>,
): ValueProbe {
	const names = [...exported]
		.filter(([, isValue]) => isValue)
		.map(([name]) => name);
	const specifier = `./${basename(entry)
		.replace(/\.ts$/u, ".js")
		.replace(/\.mts$/u, ".mjs")
		.replace(/\.cts$/u, ".cjs")}`;
	const text = [
		...names.map(
			(name, at) =>
				`import { ${name} as v${at} } from ${JSON.stringify(specifier)};`,
		),
		...names.map((_, at) => `v${at};`),
	].join("\n");
	return {
		path: join(dirname(entry), `.hobo-surface-probe-${index}.ts`),
		text,
		names,
		exported,
	};
}

function markTypeOnly(
	probes: readonly ValueProbe[],
	options: ts.CompilerOptions,
	oldProgram: ts.Program,
): void {
	const byPath = new Map(probes.map((probe) => [resolve(probe.path), probe]));
	const host = ts.createCompilerHost(options, true);
	const getSourceFile = host.getSourceFile.bind(host);
	const fileExists = host.fileExists.bind(host);
	const readFile = host.readFile.bind(host);
	host.fileExists = (fileName) =>
		byPath.has(resolve(fileName)) || fileExists(fileName);
	host.readFile = (fileName) =>
		byPath.get(resolve(fileName))?.text ?? readFile(fileName);
	host.getSourceFile = (fileName, language, onError, shouldCreate) => {
		const probe = byPath.get(resolve(fileName));
		return probe === undefined
			? getSourceFile(fileName, language, onError, shouldCreate)
			: ts.createSourceFile(fileName, probe.text, language, true);
	};
	const program = ts.createProgram({
		rootNames: probes.map((probe) => probe.path),
		options,
		host,
		oldProgram,
	});
	for (const probe of probes) {
		if (probe.names.length === 0) continue;
		const source = program.getSourceFile(probe.path);
		assert.ok(source, "the value probe is part of the program");
		for (const diagnostic of [
			...program.getSyntacticDiagnostics(source),
			...program.getSemanticDiagnostics(source),
		]) {
			if (diagnostic.start === undefined) continue;
			const line = source.getLineAndCharacterOfPosition(diagnostic.start).line;
			const name = probe.names[line % probe.names.length];
			if (name !== undefined) probe.exported.set(name, false);
		}
	}
}

function exportsOf(
	entries: readonly string[],
): ReadonlyMap<string, ReadonlyMap<string, boolean>> {
	const options: ts.CompilerOptions = {
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		target: ts.ScriptTarget.ES2022,
		noEmit: true,
		skipLibCheck: true,
		types: [],
	};
	const program = ts.createProgram(entries, options);
	const checker = program.getTypeChecker();
	const result = new Map<string, Map<string, boolean>>();
	for (const entry of entries) {
		const source = program.getSourceFile(entry);
		assert.ok(source, `${relative(root, entry)} is part of the program`);
		const module = checker.getSymbolAtLocation(source);
		assert.ok(module, `${relative(root, entry)} is a module`);
		const names = new Map<string, boolean>();
		for (const symbol of checker.getExportsOfModule(module)) {
			const target =
				(symbol.flags & ts.SymbolFlags.Alias) !== 0
					? checker.getAliasedSymbol(symbol)
					: symbol;
			names.set(symbol.name, (target.flags & ts.SymbolFlags.Value) !== 0);
		}
		result.set(entry, names);
	}
	markTypeOnly(
		entries.map((entry, index) =>
			valueProbe(entry, index, result.get(entry) ?? new Map()),
		),
		options,
		program,
	);
	return result;
}

function packageClosure(
	imported: readonly string[],
	packages: ReadonlyMap<string, PackageEntry>,
): ReadonlyMap<string, string> {
	const neededBy = new Map<string, string>(
		imported.map((name) => [name, "imported by HoBo"]),
	);
	const queue = [...imported];
	for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
		for (const dependency of packages.get(name)?.dependsOn ?? []) {
			if (neededBy.has(dependency)) continue;
			neededBy.set(dependency, `a dependency of ${name}`);
			queue.push(dependency);
		}
	}
	return neededBy;
}

describe("the reference scan", () => {
	const names = (text: string) =>
		importsIn(text, "probe.ts").map((imported) => imported.name);

	it("reads a member off an awaited import, and a destructured one", () => {
		assert.deepEqual(
			names(
				'const x = (await import("ts-autocode-training")).discoverInSource;',
			),
			["discoverInSource"],
		);
		assert.deepEqual(
			names(
				'const { discoverInSource } = await import("ts-autocode-training");',
			),
			["discoverInSource"],
		);
	});

	it("takes the whole module when the promise itself is read", () => {
		assert.deepEqual(
			names(
				'export function f() { return import("ts-autocode-training").then((m) => m.nope); }',
			),
			["*"],
		);
		assert.deepEqual(
			names('const { then } = import("ts-autocode-training");'),
			["*"],
		);
	});

	it("takes the rest of the module for a rest element", () => {
		assert.deepEqual(
			names(
				'const { discoverInSource, ...rest } = await import("ts-autocode-training");',
			),
			["discoverInSource", "*"],
		);
	});
});

describe("the export table", () => {
	it("reads a name exported type-only, in every form, as a type", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-surface-"));
		try {
			const write = (name: string, lines: readonly string[]) =>
				writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
			write("package.json", ['{ "type": "module" }']);
			write("text.ts", [
				"export const camel = 1;",
				"export function kebab() { return 2; }",
			]);
			write("figures.ts", ["export const square = 4;"]);
			write("values.ts", [
				"export const value = 3;",
				"export const aliased = 5;",
				"export const listed = 6;",
			]);
			write("index.ts", [
				'export type * from "./text.js";',
				'export type * as figures from "./figures.js";',
				'export { value } from "./values.js";',
				'export { type aliased } from "./values.js";',
				'export type { listed } from "./values.js";',
			]);
			const entry = join(dir, "index.ts");
			assert.deepEqual(
				Object.fromEntries(exportsOf([entry]).get(entry) ?? []),
				{
					camel: false,
					kebab: false,
					figures: false,
					value: true,
					aliased: false,
					listed: false,
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("ts-autocode consumer surface", () => {
	it("the submodule is checked out at its pin", () => {
		assert.ok(existsSync(join(root, SUBMODULE, "packages")), NOT_CHECKED_OUT);
	});

	const imports = packageSources(join(root, "packages")).flatMap(importsOf);

	it("finds HoBo's imports from ts-autocode (the scan is not empty)", () => {
		assert.ok(
			imports.length > 0,
			"no import from a ts-autocode package was found under packages/",
		);
	});

	it("every ts-autocode package HoBo imports, and each they depend on, is a workspace member", () => {
		const packages = submodulePackages();
		const members = workspaceMembers();
		const imported = [...new Set(imports.map((i) => i.packageName))];
		const problems = [...packageClosure(imported, packages)]
			.filter(([name]) => {
				const found = packages.get(name);
				return (
					found === undefined ||
					!members.some((member) => member.test(found.directory))
				);
			})
			.map(
				([name, why]) =>
					`${name} (${why}): ${packages.has(name) ? "not listed in pnpm-workspace.yaml" : `no package of that name under ${SUBMODULE}/packages`}`,
			);
		assert.deepEqual(problems, []);
	});

	it("every ts-autocode entry point and export HoBo imports exists at the pinned commit", () => {
		const packages = submodulePackages();
		const entryOf = (imported: ImportedName) =>
			packages.get(imported.packageName)?.entries.get(imported.entryPoint);
		const used = [
			...new Set(imports.flatMap((imported) => entryOf(imported) ?? [])),
		];
		const exported = exportsOf(used);
		const problems = new Set<string>();
		for (const imported of imports) {
			if (!packages.has(imported.packageName)) continue;
			const entry = entryOf(imported);
			if (entry === undefined) {
				problems.add(
					`${imported.file}: ${imported.specifier} is not an entry point ${imported.packageName} exports (no "import" condition for "${imported.entryPoint}")`,
				);
				continue;
			}
			const names = exported.get(entry);
			if (names === undefined || imported.name === "*") continue;
			const isValue = names.get(imported.name);
			if (isValue === undefined) {
				problems.add(
					`${imported.file}: ${imported.name} is not exported by ${imported.specifier}`,
				);
			} else if (!imported.typeOnly && !isValue) {
				problems.add(
					`${imported.file}: ${imported.name} is imported as a value but ${imported.specifier} exports only a type`,
				);
			}
		}
		assert.deepEqual([...problems], []);
	});
});

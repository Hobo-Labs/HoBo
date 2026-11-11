import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { create } from "@bufbuild/protobuf";
import { type BuildOptions, build as bundle } from "esbuild";
import ts from "typescript";
import {
	type AmbientTrainableClass,
	scanAmbientTrainableSources,
} from "./ambient-trainables.js";
import {
	createDeclarationCache,
	type DeclarationCache,
} from "./declaration-cache.js";
import { emittedPath } from "./source-files.js";
import { stableStringify } from "./text.js";
import { buildTrainables } from "./trainables.js";
import {
	CodegenArtifactSchema,
	type CodegenEngine,
	CodegenError,
	defaultCodegenLayout,
} from "./types.js";
import {
	declarationModuleSpecifier,
	emitGeneratedDeclarations,
	emitSourceDeclarationGraph,
} from "./typescript-declarations.js";
import { sourceDiagnostics } from "./typescript-diagnostics.js";

/** Compiler options are behavioral configuration; TypeScript owns their schema. */
export interface TypeScriptProjectCodegenOptions {
	readonly entrypoints?: readonly string[];
	readonly generatedRoot?: string;
	readonly runtimeModule?: string;
	readonly sourceOverrides?: Readonly<Record<string, string>>;
}

function inside(root: string, file: string): boolean {
	const path = relative(root, file);
	return (
		path === "" ||
		(!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
	);
}

/** Whether codegen treats `file` as one of the app's own sources (and reports its diagnostics). */
export function sourceCandidate(
	root: string,
	file: string,
	generatedRoots: readonly string[],
	outDir?: string,
): boolean {
	if (
		!inside(root, file) ||
		file.endsWith(".d.ts") ||
		file.endsWith(".d.mts") ||
		file.endsWith(".d.cts")
	)
		return false;
	const segments = relative(root, file).split(sep);
	if (
		segments.some(
			(segment) =>
				segment === "node_modules" ||
				segment === ".git" ||
				segment === "test" ||
				segment === "tests" ||
				segment === "__tests__",
		)
	)
		return false;
	if (/\.(?:test|spec)\.[cm]?tsx?$/u.test(file)) return false;
	return (
		!generatedRoots.some((generated) =>
			inside(resolve(root, generated), file),
		) && !(outDir && inside(resolve(root, outDir), file))
	);
}

function diagnosticsText(diagnostics: readonly ts.Diagnostic[]): string[] {
	return diagnostics.map((diagnostic) => {
		const message = ts.flattenDiagnosticMessageText(
			diagnostic.messageText,
			"\n",
		);
		if (!diagnostic.file || diagnostic.start === undefined)
			return `TS${diagnostic.code}: ${message}`;
		const line = diagnostic.file.getLineAndCharacterOfPosition(
			diagnostic.start,
		);
		return `${diagnostic.file.fileName}:${line.line + 1}:${line.character + 1} TS${diagnostic.code}: ${message}`;
	});
}

function sourceOverlay(
	root: string,
	overrides: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, string> {
	const files = new Map<string, string>();
	for (const [path, content] of Object.entries(overrides)) {
		const absolute = resolve(root, path);
		if (isAbsolute(path) || !inside(root, absolute))
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				"Source overrides must be project-relative authored paths",
			);
		files.set(absolute, content);
	}
	return files;
}

const sharedDeclarations = createDeclarationCache();

function isDefaultLibrary(file: string, options: ts.CompilerOptions): boolean {
	return (
		dirname(resolve(file)) === dirname(ts.getDefaultLibFilePath(options)) &&
		/^lib\..*\.d\.ts$/u.test(basename(file))
	);
}

/**
 * Declarations nobody edits while codegen runs: the compiler's lib files and
 * installed packages' `.d.ts`. Each codegen pass builds two programs, and
 * every pass of a long-lived process re-parsed them (0.4-1.2 s a program for
 * `@types/node`). They come from a bounded DeclarationCache instead.
 */
function isSharedDeclaration(
	file: string,
	options: ts.CompilerOptions,
): boolean {
	return (
		isDefaultLibrary(file, options) ||
		(/\.d\.[cm]?ts$/u.test(file) &&
			resolve(file).split(sep).includes("node_modules"))
	);
}

export function overlayCompilerHost(
	options: ts.CompilerOptions,
	files: ReadonlyMap<string, string>,
	declarations: DeclarationCache = sharedDeclarations,
): ts.CompilerHost {
	const host = ts.createCompilerHost(options, true);
	const readFile = host.readFile.bind(host);
	const fileExists = host.fileExists.bind(host);
	const directoryExists =
		host.directoryExists?.bind(host) ?? ts.sys.directoryExists;
	const getSourceFile = host.getSourceFile.bind(host);
	host.readFile = (file) => files.get(resolve(file)) ?? readFile(file);
	host.fileExists = (file) => files.has(resolve(file)) || fileExists(file);
	host.directoryExists = (directory) =>
		[...files.keys()].some((file) => inside(resolve(directory), file)) ||
		directoryExists(directory);
	host.getSourceFile = (
		file,
		languageVersion,
		onError,
		shouldCreateNewSourceFile,
	) => {
		const content = files.get(resolve(file));
		if (content !== undefined)
			return ts.createSourceFile(file, content, languageVersion, true);
		if (shouldCreateNewSourceFile || !isSharedDeclaration(file, options))
			return getSourceFile(
				file,
				languageVersion,
				onError,
				shouldCreateNewSourceFile,
			);
		const text = readFile(file);
		if (text === undefined)
			return getSourceFile(
				file,
				languageVersion,
				onError,
				shouldCreateNewSourceFile,
			);
		return declarations.acquire(file, options, text, languageVersion);
	};
	return host;
}

function loadProgram(
	root: string,
	generatedRoots: readonly string[],
	entrypoints?: readonly string[],
	overrides?: Readonly<Record<string, string>>,
	configurationInputs?: Set<string>,
): ts.Program {
	const configFile = join(root, "tsconfig.json");
	let options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		strict: true,
		types: [],
		noEmit: true,
	};
	let files: readonly string[];
	if (existsSync(configFile)) {
		const parsed = ts.getParsedCommandLineOfConfigFile(
			configFile,
			{},
			{
				...ts.sys,
				readFile(file) {
					const text = ts.sys.readFile(file);
					if (text !== undefined) configurationInputs?.add(resolve(file));
					return text;
				},
				onUnRecoverableConfigFileDiagnostic(diagnostic) {
					throw new CodegenError(
						"HOBO_CODEGEN_SOURCE_PARSE",
						diagnosticsText([diagnostic]).join("\n"),
						{ file: "tsconfig.json" },
					);
				},
			},
		);
		if (!parsed)
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				"Could not read tsconfig.json",
			);
		// TS18003 is expected while selecting app roots out of a project containing generated files only.
		const errors = ts
			.getConfigFileParsingDiagnostics(parsed)
			.filter((diagnostic) => diagnostic.code !== 18003);
		if (errors.length)
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				diagnosticsText(errors).join("\n"),
				{ file: "tsconfig.json" },
			);
		options = { ...parsed.options, noEmit: true };
		files = parsed.fileNames;
	} else {
		files = ts.sys.readDirectory(
			root,
			[".ts", ".tsx", ".mts", ".cts"],
			["**/node_modules/**", "**/.git/**"],
			["**/*"],
		);
	}
	const declarations = files.filter(
		(file) =>
			/\.d\.[cm]?ts$/u.test(file) &&
			!generatedRoots.some((generated) =>
				inside(resolve(root, generated), file),
			) &&
			!(options.outDir && inside(resolve(root, options.outDir), file)),
	);
	const roots = [
		...declarations,
		...(entrypoints
			? entrypoints.map((file) => resolve(root, file))
			: files.filter((file) =>
					sourceCandidate(root, file, generatedRoots, options.outDir),
				)),
	];
	const overlay = sourceOverlay(root, overrides);
	return ts.createProgram(
		[...new Set([...roots, ...overlay.keys()])],
		options,
		overlayCompilerHost(options, overlay),
	);
}

function isErasedDeclaration(declaration: ts.Declaration): boolean {
	if (declaration.getSourceFile().isDeclarationFile) return false;
	let node: ts.Node | undefined = declaration;
	while (node && !ts.isSourceFile(node)) {
		if (
			ts.canHaveModifiers(node) &&
			ts
				.getModifiers(node)
				?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
		)
			return true;
		node = node.parent;
	}
	return false;
}

function erasedExportNames(
	checker: ts.TypeChecker,
	source: ts.SourceFile,
	root: string,
	ambient: readonly AmbientTrainableClass[],
): readonly string[] {
	const module = checker.getSymbolAtLocation(source);
	if (!module) return [];
	const names: string[] = [];
	for (const symbol of checker.getExportsOfModule(module)) {
		const target =
			symbol.flags & ts.SymbolFlags.Alias
				? checker.getAliasedSymbol(symbol)
				: symbol;
		if (!(target.flags & ts.SymbolFlags.Value)) continue;
		const declarations = target.declarations ?? [];
		if (!declarations.length || !declarations.every(isErasedDeclaration))
			continue;
		const registered = ambient.some(
			(entry) =>
				entry.declared.className === target.name &&
				declarations.some(
					(declaration) =>
						relative(root, declaration.getSourceFile().fileName)
							.split(sep)
							.join("/") === entry.file,
				),
		);
		if (!registered)
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				`Export ${JSON.stringify(symbol.name)} in ${relative(root, source.fileName)} is an ambient value with no runtime implementation or trainable registration`,
				{ file: relative(root, source.fileName) },
			);
		names.push(symbol.name);
	}
	return names;
}

function commonJsExport(source: ts.SourceFile): ts.Expression | undefined {
	return source.statements.find(
		(statement): statement is ts.ExportAssignment =>
			ts.isExportAssignment(statement) && statement.isExportEquals === true,
	)?.expression;
}

function runtimeExports(
	checker: ts.TypeChecker,
	source: ts.SourceFile,
	root: string,
	ambient: readonly AmbientTrainableClass[],
): readonly ts.Symbol[] {
	const module = checker.getSymbolAtLocation(source);
	if (!module) return [];
	const commonJs = commonJsExport(source);
	if (commonJs) {
		let target = checker.getSymbolAtLocation(commonJs);
		if (target && target.flags & ts.SymbolFlags.Alias)
			target = checker.getAliasedSymbol(target);
		if (
			target?.declarations?.length &&
			target.declarations.every(isErasedDeclaration)
		) {
			const registered = ambient.some(
				(entry) =>
					entry.declared.className === target?.name &&
					target.declarations?.some(
						(declaration) =>
							relative(root, declaration.getSourceFile().fileName)
								.split(sep)
								.join("/") === entry.file,
					),
			);
			if (registered) return [];
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				"CommonJS export assignment has no runtime implementation",
				{ file: relative(root, source.fileName) },
			);
		}
		if (target && !(target.flags & ts.SymbolFlags.Value))
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				"CommonJS export assignment names a type with no runtime value",
			);
		return [module];
	}
	const erased = new Set(erasedExportNames(checker, source, root, ambient));
	return checker.getExportsOfModule(module).filter((symbol) => {
		const target =
			symbol.flags & ts.SymbolFlags.Alias
				? checker.getAliasedSymbol(symbol)
				: symbol;
		return (
			Boolean(target.flags & ts.SymbolFlags.Value) && !erased.has(symbol.name)
		);
	});
}

function projectAmbientClasses(
	program: ts.Program,
	root: string,
	generatedRoots: readonly string[],
): readonly AmbientTrainableClass[] {
	return scanAmbientTrainableSources(
		program
			.getSourceFiles()
			.filter((source) =>
				sourceCandidate(
					root,
					source.fileName,
					generatedRoots,
					program.getCompilerOptions().outDir,
				),
			)
			.map((source) => ({
				file: relative(root, source.fileName).split(sep).join("/"),
				source: source.text,
			})),
	);
}

function ambientDecoratorDiagnostic(
	diagnostic: ts.Diagnostic,
	root: string,
	ambient: readonly AmbientTrainableClass[],
): boolean {
	if (
		diagnostic.code !== 1206 ||
		!diagnostic.file ||
		diagnostic.start === undefined
	)
		return false;
	const file = relative(root, diagnostic.file.fileName).split(sep).join("/");
	const names = new Set(
		ambient
			.filter((entry) => entry.file === file)
			.map((entry) => entry.declared.className),
	);
	const position = diagnostic.start;
	let within = false;
	const visit = (node: ts.Node): void => {
		if (
			ts.isClassDeclaration(node) &&
			node.name &&
			names.has(node.name.text) &&
			position >= node.getStart() &&
			position < node.end
		)
			within = true;
		ts.forEachChild(node, visit);
	};
	visit(diagnostic.file);
	return within;
}

function projectSources(
	program: ts.Program,
	root: string,
	generatedRoots: readonly string[],
): readonly ts.SourceFile[] {
	return program
		.getRootFileNames()
		.map((file) => program.getSourceFile(file))
		.filter(
			(source): source is ts.SourceFile =>
				source !== undefined &&
				sourceCandidate(
					root,
					source.fileName,
					generatedRoots,
					program.getCompilerOptions().outDir,
				),
		)
		.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

/** Only authored application roots start eagerly; imported modules keep their authored timing. */
function applicationSources(
	program: ts.Program,
	root: string,
	generatedRoots: readonly string[],
	ambient: readonly AmbientTrainableClass[],
	options: TypeScriptProjectCodegenOptions,
): readonly ts.SourceFile[] {
	const checker = program.getTypeChecker();
	const candidates = projectSources(program, root, generatedRoots).filter(
		(source) => runtimeExports(checker, source, root, ambient).length > 0,
	);
	const byPath = new Map(
		candidates.map((source) => [resolve(source.fileName), source]),
	);
	if (options.entrypoints) {
		return options.entrypoints.flatMap((file) => {
			const source = byPath.get(resolve(root, file));
			return source ? [source] : [];
		});
	}
	const compilerOptions = program.getCompilerOptions();
	const resolveEntry = (file: string): ts.SourceFile | undefined => {
		const absolute = resolve(root, file);
		const direct = byPath.get(absolute);
		if (direct) return direct;
		// Package metadata commonly points at emitted JavaScript, rather than its TypeScript input.
		for (const source of candidates) {
			const inputRoot = compilerOptions.rootDir ?? root;
			const emitted = resolve(
				compilerOptions.outDir ?? inputRoot,
				emittedPath(
					relative(inputRoot, source.fileName),
					compilerOptions.jsx === ts.JsxEmit.Preserve,
				),
			);
			if (emitted === absolute) return source;
			if (
				resolve(
					emittedPath(
						source.fileName,
						compilerOptions.jsx === ts.JsxEmit.Preserve,
					),
				) === absolute
			)
				return source;
		}
		return undefined;
	};
	const metadataPath = join(root, "package.json");
	if (existsSync(metadataPath)) {
		const metadata = ts.parseJsonText(
			metadataPath,
			readFileSync(metadataPath, "utf8"),
		).statements[0];
		const property = (
			value: ts.Expression | undefined,
			name: string,
		): ts.Expression | undefined => {
			if (!value || !ts.isObjectLiteralExpression(value)) return undefined;
			for (const member of value.properties) {
				if (
					ts.isPropertyAssignment(member) &&
					(ts.isIdentifier(member.name) ||
						ts.isStringLiteralLike(member.name)) &&
					member.name.text === name
				)
					return member.initializer;
			}
			return undefined;
		};
		const collect = (
			value: ts.Expression | undefined,
		): ts.SourceFile | undefined => {
			if (!value) return undefined;
			if (ts.isStringLiteralLike(value)) return resolveEntry(value.text);
			if (ts.isArrayLiteralExpression(value)) {
				for (const target of value.elements) {
					const selected = collect(target);
					if (selected) return selected;
				}
			} else if (ts.isObjectLiteralExpression(value)) {
				for (const member of value.properties) {
					if (
						ts.isPropertyAssignment(member) &&
						(ts.isIdentifier(member.name) ||
							ts.isStringLiteralLike(member.name)) &&
						["node", "import", "default"].includes(member.name.text)
					) {
						const selected = collect(member.initializer);
						if (selected) return selected;
					}
				}
			}
			return undefined;
		};
		const object =
			metadata && ts.isExpressionStatement(metadata)
				? metadata.expression
				: undefined;
		const exports = property(object, "exports");
		for (const target of [
			property(object, "entry"),
			property(object, "source"),
			property(exports, ".") ?? exports,
			property(object, "module"),
			property(object, "main"),
		]) {
			const selected = collect(target);
			if (selected) return [selected];
		}
	}
	for (const directory of ["", "src", "source"]) {
		for (const stem of ["app", "index"]) {
			const selected = [".ts", ".tsx", ".mts", ".cts"].flatMap((extension) => {
				const source = byPath.get(
					resolve(root, directory, `${stem}${extension}`),
				);
				return source ? [source] : [];
			});
			if (selected.length) return selected;
		}
	}

	// Condense the compiler-resolved dependency graph into strongly connected components.
	// Dynamic and type-only imports count as dependencies, without executing either.
	const sources = program
		.getSourceFiles()
		.filter(
			(source) =>
				!source.isDeclarationFile &&
				!source.fileName.split(sep).includes("node_modules"),
		);
	const graph = new Map(
		sources.map((source) => [resolve(source.fileName), new Set<string>()]),
	);
	const host = overlayCompilerHost(
		compilerOptions,
		sourceOverlay(root, options.sourceOverrides),
	);
	for (const source of sources) {
		const edges = graph.get(resolve(source.fileName));
		const visit = (node: ts.Node): void => {
			let specifier: ts.Expression | undefined;
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
				specifier = node.moduleSpecifier;
			else if (
				ts.isImportEqualsDeclaration(node) &&
				ts.isExternalModuleReference(node.moduleReference)
			)
				specifier = node.moduleReference.expression;
			else if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) &&
						node.expression.text === "require"))
			)
				specifier = node.arguments[0];
			else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
				specifier = node.argument.literal;
			if (specifier && ts.isStringLiteralLike(specifier)) {
				const target = ts.resolveModuleName(
					specifier.text,
					source.fileName,
					compilerOptions,
					host,
				).resolvedModule;
				if (target && graph.has(resolve(target.resolvedFileName)))
					edges?.add(resolve(target.resolvedFileName));
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	// Unreferenced type-only roots are erased and cannot suppress a runtime entry.
	// Keep intermediates reached from runtime candidates, including lazy/type imports.
	const reachable = new Set<string>();
	const mark = (file: string): void => {
		if (reachable.has(file)) return;
		reachable.add(file);
		for (const dependency of graph.get(file) ?? []) mark(dependency);
	};
	for (const source of candidates) mark(resolve(source.fileName));
	for (const file of graph.keys()) if (!reachable.has(file)) graph.delete(file);
	let nextIndex = 0;
	const indices = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const active = new Set<string>();
	const components: string[][] = [];
	const visit = (file: string): void => {
		const index = nextIndex++;
		indices.set(file, index);
		low.set(file, index);
		stack.push(file);
		active.add(file);
		for (const dependency of graph.get(file) ?? []) {
			if (!indices.has(dependency)) {
				visit(dependency);
				low.set(
					file,
					Math.min(low.get(file) ?? index, low.get(dependency) ?? index),
				);
			} else if (active.has(dependency))
				low.set(
					file,
					Math.min(low.get(file) ?? index, indices.get(dependency) ?? index),
				);
		}
		if (low.get(file) !== index) return;
		const component: string[] = [];
		let member: string | undefined;
		do {
			member = stack.pop();
			if (member !== undefined) {
				active.delete(member);
				component.push(member);
			}
		} while (member !== file && member !== undefined);
		components.push(component);
	};
	for (const file of graph.keys()) if (!indices.has(file)) visit(file);
	const membership = new Map(
		components.flatMap((component, index) =>
			component.map((file) => [file, index] as const),
		),
	);
	const incoming = new Set<number>();
	for (const [file, dependencies] of graph) {
		for (const dependency of dependencies) {
			const target = membership.get(dependency);
			if (target !== undefined && membership.get(file) !== target)
				incoming.add(target);
		}
	}
	return components
		.flatMap((component, index) => {
			if (incoming.has(index)) return [];
			const source = component.sort().flatMap((file) => {
				const candidate = byPath.get(file);
				return candidate ? [candidate] : [];
			})[0];
			return source ? [source] : [];
		})
		.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

interface ModuleImprint {
	readonly path: string;
	readonly symbol: string;
	readonly sourceFile: string;
	readonly exportNames: readonly string[];
	readonly commonJs: boolean;
}

async function bundleRuntimeModules(
	root: string,
	program: ts.Program,
	generatedRoot: string,
	records: readonly ModuleImprint[],
	declarationPaths: ReadonlyMap<string, string>,
	ambientDeclarations: readonly string[],
	compilerJavascript: ReadonlyMap<string, { content: string; jsx: boolean }>,
	overrides?: Readonly<Record<string, string>>,
) {
	if (!records.length) return { artifacts: [], inputs: [] };
	const runtimeRoot = resolve(root, generatedRoot, "runtime");
	const overlay = sourceOverlay(root, overrides);
	const host = overlayCompilerHost(program.getCompilerOptions(), overlay);
	try {
		const bundleOptions: BuildOptions = {
			absWorkingDir: root,
			entryPoints: Object.fromEntries(
				records.map((record) => [record.symbol, record.sourceFile]),
			),
			outdir: runtimeRoot,
			outExtension: { ".js": ".mjs" },
			bundle: true,
			splitting: true,
			write: false,
			metafile: true,
			format: "esm",
			platform: "node",
			target: "node20",
			packages: "external",
			treeShaking: true,
			logLevel: "silent",
			assetNames: "assets/[name]-[hash]",
			loader: {
				".png": "file",
				".jpg": "file",
				".jpeg": "file",
				".gif": "file",
				".webp": "file",
				".avif": "file",
				".ico": "file",
				".svg": "file",
				".woff": "file",
				".woff2": "file",
				".ttf": "file",
				".otf": "file",
				".wasm": "file",
				".bin": "file",
			},
			plugins: [
				{
					name: "typescript-project-local-aliases",
					setup(build) {
						build.onResolve({ filter: /.*/ }, (args) => {
							const direct = isAbsolute(args.path)
								? resolve(args.path)
								: args.path.startsWith(".")
									? resolve(args.resolveDir, args.path)
									: undefined;
							if (direct && overlay.has(direct)) return { path: direct };
							if (!args.importer) return undefined;
							const resolved = ts.resolveModuleName(
								args.path,
								args.importer,
								program.getCompilerOptions(),
								host,
							).resolvedModule;
							if (
								!resolved ||
								resolved.resolvedFileName.split(sep).includes("node_modules") ||
								/\.d\.[cm]?ts$/u.test(resolved.resolvedFileName)
							)
								return undefined;
							return { path: resolved.resolvedFileName };
						});
						build.onLoad({ filter: /\.[cm]?tsx?$/ }, (args) => {
							const compiled = compilerJavascript.get(resolve(args.path));
							if (compiled)
								return {
									contents: compiled.content,
									loader: compiled.jsx ? "jsx" : "js",
									resolveDir: dirname(args.path),
								};
							const contents = overlay.get(resolve(args.path));
							if (contents === undefined) return undefined;
							return {
								contents,
								loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
								resolveDir: dirname(args.path),
							};
						});
					},
				},
			],
		};
		if (existsSync(join(root, "tsconfig.json")))
			bundleOptions.tsconfig = join(root, "tsconfig.json");
		const result = await bundle(bundleOptions);
		if (!result.outputFiles)
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				"App bundler returned no executable artifacts",
			);
		const artifacts = result.outputFiles.map((file) => {
			const path = relative(root, file.path).split(sep).join("/");
			return /\.(?:mjs|js|css|map)$/u.test(file.path)
				? create(CodegenArtifactSchema, { path, content: file.text })
				: create(CodegenArtifactSchema, { path, binaryContent: file.contents });
		});
		for (const record of records) {
			const declaration = declarationPaths.get(resolve(record.sourceFile));
			if (!declaration)
				throw new CodegenError(
					"HOBO_CODEGEN_SOURCE_PARSE",
					`Missing compiler declaration for ${record.path}`,
				);
			const output = `${generatedRoot}/runtime/${record.symbol}.d.mts`;
			const source = declarationModuleSpecifier(output, declaration);
			const references = ambientDeclarations
				.map(
					(path) =>
						`/// <reference path=${JSON.stringify(relative(dirname(output), path).split(sep).join("/"))} />`,
				)
				.join("\n");
			artifacts.push(
				create(CodegenArtifactSchema, {
					path: output,
					content: `${references}\n${
						record.commonJs
							? `declare const implementation: typeof import(${JSON.stringify(source)});\nexport default implementation;\n`
							: `export { ${record.exportNames.map((name) => JSON.stringify(name)).join(", ")} } from ${JSON.stringify(source)};\n`
					}`,
				}),
			);
		}
		return {
			artifacts,
			// Embedded data-URL modules have no filesystem input; their bytes live in the importing source.
			inputs: Object.keys(result.metafile?.inputs ?? {})
				.filter((file) => !/^<.*>$/u.test(file))
				.map((file) => resolve(root, file)),
		};
	} catch (error) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`Could not bundle executable TypeScript app imports: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function registrationBuild(
	ambient: readonly AmbientTrainableClass[],
	generatedRoot: string,
	runtimeModule: string,
) {
	if (!ambient.length) return undefined;
	const base = defaultCodegenLayout();
	return buildTrainables(
		{ rawSources: {}, resources: [], scopes: [], bindles: [] },
		{
			...base,
			files: { ...base.files, trainables: `${generatedRoot}/trainables.ts` },
			imports: { ...base.imports, runtimeModule },
		},
		[],
		ambient,
	);
}

/** Copy the generated executable bundle and its module declarations beside emitted app.js. */
export async function packageTypeScriptAppArtifacts(
	projectRoot: string,
	outputRoot: string,
	options: Pick<TypeScriptProjectCodegenOptions, "generatedRoot"> & {
		readonly outputGeneratedRoot?: string;
	} = {},
): Promise<readonly string[]> {
	const generatedRoot = options.generatedRoot ?? "src/_generated/app-imprint";
	const source = resolve(projectRoot, generatedRoot);
	const destination = resolve(
		outputRoot,
		options.outputGeneratedRoot ?? generatedRoot,
	);
	if (inside(source, destination) || inside(destination, source))
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			"Runtime artifact packaging destination must not overlap the generated source runtime directory",
		);
	if (!existsSync(source)) return [];
	const copied: string[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink())
				throw new CodegenError(
					"HOBO_CODEGEN_SOURCE_PARSE",
					"Runtime artifact packaging refuses symbolic links",
				);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!entry.isFile())
				throw new CodegenError(
					"HOBO_CODEGEN_SOURCE_PARSE",
					"Runtime artifact packaging requires ordinary files",
				);
			if (
				!inside(resolve(source, "runtime"), path) &&
				!/\.d\.[cm]?ts$/u.test(path)
			)
				continue;
			const target = resolve(destination, relative(source, path));
			await mkdir(dirname(target), { recursive: true });
			await copyFile(path, target);
			copied.push(relative(resolve(outputRoot), target).split(sep).join("/"));
		}
	}
	await visit(source);
	return copied.sort();
}

/** Detect compiler-visible authored modules, without importing/evaluating application code. */
export async function selectTypeScriptProjectCodegenEngine(
	projectRoot: string,
): Promise<CodegenEngine | undefined> {
	const root = resolve(projectRoot);
	const generatedRoots = [
		".hobo/generated/app-imprint",
		"src/_generated/app-imprint",
	];
	const program = loadProgram(root, generatedRoots);
	const checker = program.getTypeChecker();
	const ambient = projectAmbientClasses(program, root, generatedRoots);
	if (
		ambient.length === 0 &&
		!projectSources(program, root, generatedRoots).some(
			(source) => runtimeExports(checker, source, root, ambient).length > 0,
		)
	)
		return undefined;
	return createTypeScriptProjectCodegenEngine();
}

/**
 * Imprint executable module namespaces. `typeof import` retains the compiler's
 * complete type graph: imported/nested/recursive types, overloads, generics,
 * class constructors and methods are not reconstructed from lossy text shapes.
 */
export function createTypeScriptProjectCodegenEngine(
	options: TypeScriptProjectCodegenOptions = {},
): CodegenEngine {
	const base = defaultCodegenLayout();
	const generatedRoot = options.generatedRoot ?? "src/_generated/app-imprint";
	const manifestRoot = ".hobo/generated/app-imprint";
	const generatedRoots = [manifestRoot, generatedRoot];
	return {
		layout: {
			...base,
			generatedRoots,
			files: {
				...base.files,
				manifest: `${manifestRoot}/codegen-manifest.json`,
				apiTree: `${generatedRoot}/app.ts`,
				bindings: `${generatedRoot}/bindings.ts`,
				trainables: `${generatedRoot}/trainables.ts`,
			},
		},
		async describeTrainables(projectRoot) {
			const root = resolve(projectRoot);
			const program = loadProgram(
				root,
				generatedRoots,
				options.entrypoints,
				options.sourceOverrides,
			);
			return (
				registrationBuild(
					projectAmbientClasses(program, root, generatedRoots),
					generatedRoot,
					options.runtimeModule ?? base.imports.runtimeModule,
				)?.stubs ?? []
			);
		},
		async generate(projectRoot) {
			const root = resolve(projectRoot);
			const configurationInputs = new Set<string>();
			const program = loadProgram(
				root,
				generatedRoots,
				options.entrypoints,
				options.sourceOverrides,
				configurationInputs,
			);
			const checker = program.getTypeChecker();
			const ambient = projectAmbientClasses(program, root, generatedRoots);
			const modules = applicationSources(
				program,
				root,
				generatedRoots,
				ambient,
				options,
			);
			if (modules.length === 0 && ambient.length === 0)
				throw new CodegenError(
					"HOBO_CODEGEN_SOURCE_PARSE",
					"TypeScript project has no exported runtime app modules",
				);
			const errors = sourceDiagnostics(program, (file) =>
				sourceCandidate(
					root,
					file,
					generatedRoots,
					program.getCompilerOptions().outDir,
				),
			).filter(
				(diagnostic) => !ambientDecoratorDiagnostic(diagnostic, root, ambient),
			);
			if (errors.length)
				throw new CodegenError(
					"HOBO_CODEGEN_SOURCE_PARSE",
					diagnosticsText(errors).join("\n"),
					{ file: "tsconfig.json" },
				);
			const appFile = `${generatedRoot}/app.ts`;
			const bindingsFile = `${generatedRoot}/bindings.ts`;
			const records = modules.map((source, index) => {
				const path = relative(root, source.fileName).split(sep).join("/");
				return {
					path,
					symbol: `appModule${index}`,
					sourceFile: source.fileName,
					commonJs: commonJsExport(source) !== undefined,
					exportNames: runtimeExports(checker, source, root, ambient).map(
						(symbol) => symbol.name,
					),
				};
			});
			const imports = records
				.map(
					(record) =>
						`${record.commonJs ? `import ${record.symbol}` : `import * as ${record.symbol}`} from ${JSON.stringify(`./runtime/${record.symbol}.mjs`)};`,
				)
				.join("\n");
			const rows = records
				.map((record) => `  ${JSON.stringify(record.path)}: ${record.symbol},`)
				.join("\n");
			const bindings = records
				.map(
					(record) =>
						`  ${JSON.stringify(record.path)}: typeof import(${JSON.stringify(`./runtime/${record.symbol}.mjs`)})${record.commonJs ? ".default" : ""};`,
				)
				.join("\n");
			const trainables = registrationBuild(
				ambient,
				generatedRoot,
				options.runtimeModule ?? base.imports.runtimeModule,
			);
			const mapping = ambient.map((entry) => ({
				file: entry.file,
				className: entry.declared.className,
				operations: entry.declared.operations.map((operation) => ({
					methodRef: operation.methodRef,
					exportName: trainables?.stubs.find(
						(stub) => stub.methodRef === operation.methodRef,
					)?.exportName,
				})),
			}));
			const app = `${imports}${trainables ? `\nimport * as trainables from "./trainables.js";\nexport { trainables };` : ""}\nimport type { AppModules } from "./bindings.js";\n\nexport const app: AppModules = {\n${rows}${trainables ? "\n  trainables," : ""}\n};\n\nexport function createAppClient(): AppModules {\n  return app;\n}\n\nexport function getAppModule<Path extends keyof AppModules>(path: Path): AppModules[Path] {\n  return app[path];\n}\n\nexport function resolveAppAsset(path: string): URL {\n  return new URL(path, new URL("./runtime/", import.meta.url));\n}\n`;
			const declarations = emitSourceDeclarationGraph(
				root,
				program,
				generatedRoot,
				overlayCompilerHost,
			);
			const runtimeArtifacts = await bundleRuntimeModules(
				root,
				program,
				generatedRoot,
				records,
				declarations.paths,
				declarations.ambient,
				declarations.javascript,
				options.sourceOverrides,
			);
			const sourceDigests: Record<string, string> = {};
			const externalSourceDigests: Record<string, string> = {};
			const inputs = new Set([
				...configurationInputs,
				...runtimeArtifacts.inputs,
				...program
					.getSourceFiles()
					.filter(
						(source) =>
							!program.isSourceFileDefaultLibrary(source) &&
							!program.isSourceFileFromExternalLibrary(source) &&
							!source.fileName.split(sep).includes("node_modules"),
					)
					.map((source) => resolve(source.fileName)),
			]);
			// Package boundaries affect entry selection, module interpretation and bundler resolution.
			for (const input of [...inputs, join(root, "app.ts")]) {
				for (let directory = dirname(input); ; directory = dirname(directory)) {
					const metadata = join(directory, "package.json");
					if (existsSync(metadata)) inputs.add(metadata);
					if (dirname(directory) === directory) break;
				}
			}
			if (existsSync(join(root, "hobo.bindle.json")))
				inputs.add(join(root, "hobo.bindle.json"));
			const overlay = sourceOverlay(root, options.sourceOverrides);
			for (const file of [...inputs].sort()) {
				if (generatedRoots.some((path) => inside(resolve(root, path), file)))
					continue;
				const path = relative(root, file).split(sep).join("/");
				const bytes = overlay.has(file)
					? Buffer.from(overlay.get(file) ?? "")
					: readFileSync(file);
				const digests = inside(root, file)
					? sourceDigests
					: externalSourceDigests;
				digests[path] =
					`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
			}
			const artifacts = [
				...declarations.artifacts,
				...runtimeArtifacts.artifacts,
				...(trainables
					? [trainables.artifact, ...trainables.declaredArtifacts]
					: []),
				create(CodegenArtifactSchema, { path: appFile, content: app }),
				create(CodegenArtifactSchema, {
					path: bindingsFile,
					content: `export interface AppModules {\n${bindings}${trainables ? `\n  readonly trainables: typeof import("./trainables.js");` : ""}\n}\n\nexport const trainableMappings = ${JSON.stringify(mapping)} as const;\n\nexport const modulePaths = ${JSON.stringify(records.map((record) => record.path))} as const;\n`,
				}),
				create(CodegenArtifactSchema, {
					path: `${manifestRoot}/codegen-manifest.json`,
					content: stableStringify({
						schema: "hobo.codegen-manifest/v1",
						generatedBy: "hobo codegen",
						guestLanguage: "ts",
						layout: generatedRoots,
						sourceDigests,
						sourceDigestEncoding: "raw",
						externalSourceDigests,
						resources: records.map((record) => record.path),
						scopes: [],
						bindles: [],
					}),
				}),
			];
			return [
				...artifacts,
				...emitGeneratedDeclarations(
					root,
					program,
					generatedRoot,
					artifacts,
					declarations.paths,
					overlayCompilerHost,
				),
			];
		},
	};
}

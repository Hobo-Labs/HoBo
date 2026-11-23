import {
	basename,
	dirname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import { create } from "@bufbuild/protobuf";
import ts from "typescript";
import { digest } from "./text.js";
import { type CodegenArtifact, CodegenArtifactSchema } from "./types.js";

type HostFactory = (
	options: ts.CompilerOptions,
	files: ReadonlyMap<string, string>,
) => ts.CompilerHost;

function within(root: string, file: string): boolean {
	const path = relative(root, file);
	return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function specifier(from: string, to: string): string {
	const path = relative(dirname(from), to)
		.split(sep)
		.join("/")
		.replace(/\.d\.([cm]?)ts$/u, ".$1js");
	return path.startsWith(".") ? path : `./${path}`;
}

function declarationPath(
	root: string,
	generatedRoot: string,
	source: ts.SourceFile,
): string {
	const file = within(root, source.fileName)
		? `project/${relative(root, source.fileName).split(sep).join("/")}`
		: `dependencies/${digest(relative(root, dirname(source.fileName))).slice(7, 23)}/${basename(source.fileName)}`;
	const target = source.isDeclarationFile
		? file
		: file.endsWith(".json")
			? `${file}.d.ts`
			: file.replace(/\.([cm]?)tsx?$/u, ".d.$1ts");
	return `${generatedRoot}/runtime/types/${target}`;
}

function rewriteImports(
	text: string,
	source: ts.SourceFile,
	output: string,
	paths: ReadonlyMap<string, string>,
	options: ts.CompilerOptions,
	host: ts.CompilerHost,
	ambientTargets: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): string {
	const parsed = ts.createSourceFile(
		output,
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const edits: { start: number; end: number; value: string }[] = [];
	const visit = (node: ts.Node): void => {
		let literal: ts.Node | undefined;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			literal = node.moduleSpecifier;
		else if (ts.isExternalModuleReference(node)) literal = node.expression;
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			literal = node.argument.literal;
		if (literal && ts.isStringLiteralLike(literal)) {
			const resolved = ts.resolveModuleName(
				literal.text,
				source.fileName,
				options,
				host,
			).resolvedModule;
			const target =
				(resolved && paths.get(resolve(resolved.resolvedFileName))) ??
				ambientTargets.get(resolve(source.fileName))?.get(literal.text);
			if (target)
				edits.push({
					start: literal.getStart(parsed),
					end: literal.end,
					value: JSON.stringify(specifier(output, target)),
				});
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	for (const reference of parsed.referencedFiles) {
		const target = paths.get(
			resolve(dirname(source.fileName), reference.fileName),
		);
		if (target) {
			const path = relative(dirname(output), target).split(sep).join("/");
			edits.push({
				start: reference.pos,
				end: reference.end,
				value: path.startsWith(".") ? path : `./${path}`,
			});
		}
	}
	for (const edit of edits.sort((left, right) => right.start - left.start))
		text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
	return text;
}

export function emitSourceDeclarationGraph(
	root: string,
	program: ts.Program,
	generatedRoot: string,
	hostFactory: HostFactory,
) {
	const sources = program
		.getSourceFiles()
		.filter(
			(source) =>
				!source.fileName.split(sep).includes("node_modules") &&
				!program.isSourceFileDefaultLibrary(source) &&
				!program.isSourceFileFromExternalLibrary(source),
		);
	const paths = new Map(
		sources.map((source) => [
			resolve(source.fileName),
			declarationPath(root, generatedRoot, source),
		]),
	);
	const files = new Map(
		program
			.getSourceFiles()
			.map((source) => [resolve(source.fileName), source.text]),
	);
	let common = root;
	for (const source of sources)
		while (!within(common, source.fileName)) common = dirname(common);
	const options: ts.CompilerOptions = {
		...program.getCompilerOptions(),
		rootDir: common,
		outDir: resolve(root, generatedRoot, "runtime/types"),
		declarationDir: resolve(root, generatedRoot, "runtime/types"),
		noEmit: false,
		declaration: true,
		emitDeclarationOnly: true,
		declarationMap: false,
		noEmitOnError: false,
		stripInternal: false,
	};
	const compilerJavascript =
		program.getCompilerOptions().emitDecoratorMetadata === true;
	if (compilerJavascript) {
		options.emitDeclarationOnly = false;
		options.module = ts.ModuleKind.Preserve;
		options.moduleResolution = ts.ModuleResolutionKind.Bundler;
		options.preserveConstEnums = true;
		options.sourceMap = false;
		options.inlineSourceMap = false;
	}
	const host = hostFactory(options, files);
	const emitted = new Map<string, { source: ts.SourceFile; text: string }>();
	const javascript = new Map<string, { content: string; jsx: boolean }>();
	const declarations = ts.createProgram(
		program.getRootFileNames(),
		options,
		host,
	);
	declarations.emit(
		undefined,
		(file, text, _bom, _onError, sourceFiles) => {
			const source = sourceFiles?.[0];
			const path = source && paths.get(resolve(source.fileName));
			if (source && path && /\.d\.[cm]?ts$/u.test(file))
				emitted.set(path, { source, text });
			else if (source && /\.[cm]?jsx?$/u.test(file))
				javascript.set(resolve(source.fileName), {
					content: text,
					jsx: file.endsWith(".jsx"),
				});
		},
		undefined,
		!compilerJavascript,
	);
	const printer = ts.createPrinter();
	const ambientTargets = new Map<string, Map<string, string>>();
	const checker = program.getTypeChecker();
	for (const source of sources) {
		const visit = (node: ts.Node): void => {
			let literal: ts.Node | undefined;
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
				literal = node.moduleSpecifier;
			else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
				literal = node.argument.literal;
			if (literal && ts.isStringLiteralLike(literal)) {
				const symbol = checker.getSymbolAtLocation(literal);
				const declaration = symbol?.declarations?.find(
					(node) =>
						ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name),
				);
				if (
					declaration &&
					ts.isModuleDeclaration(declaration) &&
					!program.isSourceFileFromExternalLibrary(declaration.getSourceFile())
				) {
					const path = `${generatedRoot}/runtime/types/ambient/${digest(symbol?.name ?? literal.text).slice(7, 23)}.d.ts`;
					const targets =
						ambientTargets.get(resolve(source.fileName)) ??
						new Map<string, string>();
					targets.set(literal.text, path);
					ambientTargets.set(resolve(source.fileName), targets);
					if (!emitted.has(path)) {
						const statements =
							declaration.body && ts.isModuleBlock(declaration.body)
								? declaration.body.statements
								: [];
						const text = statements
							.map((statement) => {
								const modifiers = ts.canHaveModifiers(statement)
									? ts.getModifiers(statement)
									: undefined;
								const needsDeclare =
									(ts.isVariableStatement(statement) ||
										ts.isFunctionDeclaration(statement) ||
										ts.isClassDeclaration(statement) ||
										ts.isEnumDeclaration(statement) ||
										ts.isModuleDeclaration(statement)) &&
									!modifiers?.some(
										(modifier) =>
											modifier.kind === ts.SyntaxKind.DeclareKeyword ||
											modifier.kind === ts.SyntaxKind.ExportKeyword,
									);
								return `${needsDeclare ? "declare " : ""}${statement.getText(declaration.getSourceFile())}`;
							})
							.join("\n");
						emitted.set(path, {
							source: declaration.getSourceFile(),
							text: `${text}\nexport {};\n`,
						});
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}

	for (const source of sources) {
		const path = paths.get(resolve(source.fileName));
		if (!path) continue;
		if (source.isDeclarationFile) {
			const statements = source.statements.filter(
				(statement) =>
					!(
						ts.isModuleDeclaration(statement) &&
						ts.isStringLiteral(statement.name)
					),
			);
			if (ts.isExternalModule(source) || statements.length)
				emitted.set(path, {
					source,
					text: statements
						.map((statement) => statement.getFullText(source))
						.join("\n"),
				});
		} else if (source.fileName.endsWith(".json")) {
			const statement = source.statements[0];
			if (statement && ts.isExpressionStatement(statement)) {
				const type = program
					.getTypeChecker()
					.typeToTypeNode(
						program.getTypeChecker().getTypeAtLocation(statement.expression),
						undefined,
						ts.NodeBuilderFlags.NoTruncation,
					);
				if (type)
					emitted.set(path, {
						source,
						text: `declare const value: ${printer.printNode(ts.EmitHint.Unspecified, type, source)};\nexport default value;\n`,
					});
			}
		}
	}
	const ambient = sources
		.filter(
			(source) =>
				source.isDeclarationFile &&
				emitted.has(paths.get(resolve(source.fileName)) ?? ""),
		)
		.flatMap((source) => {
			const path = paths.get(resolve(source.fileName));
			return path ? [path] : [];
		});
	return {
		paths,
		ambient,
		javascript,
		ambientTargets,
		artifacts: [...emitted].map(([path, entry]) =>
			create(CodegenArtifactSchema, {
				path,
				content: rewriteImports(
					entry.text,
					entry.source,
					path,
					paths,
					options,
					host,
					ambientTargets,
				),
			}),
		),
	};
}

export function emitGeneratedDeclarations(
	root: string,
	program: ts.Program,
	generatedRoot: string,
	artifacts: readonly CodegenArtifact[],
	sourceDeclarationPaths: ReadonlyMap<string, string>,
	hostFactory: HostFactory,
): readonly CodegenArtifact[] {
	const files = new Map(
		program
			.getSourceFiles()
			.map((source) => [resolve(source.fileName), source.text]),
	);
	const roots = artifacts.filter((artifact) =>
		/(?<!\.d)\.[cm]?ts$/u.test(artifact.path),
	);
	for (const artifact of artifacts)
		if (/\.[cm]?ts$/u.test(artifact.path))
			files.set(resolve(root, artifact.path), artifact.content);
	const options: ts.CompilerOptions = {
		...program.getCompilerOptions(),
		rootDir: root,
		outDir: resolve(root, generatedRoot, ".declaration-output"),
		declarationDir: resolve(root, generatedRoot, ".declaration-output"),
		noEmit: false,
		declaration: true,
		emitDeclarationOnly: true,
		declarationMap: false,
		noEmitOnError: false,
		stripInternal: false,
	};
	const host = hostFactory(options, files);
	const paths = new Map(sourceDeclarationPaths);
	for (const artifact of roots)
		paths.set(
			resolve(root, artifact.path),
			artifact.path.replace(/\.([cm]?)ts$/u, ".d.$1ts"),
		);
	const declarations = ts.createProgram(
		[
			...program.getRootFileNames(),
			...roots.map((artifact) => resolve(root, artifact.path)),
		],
		options,
		host,
	);
	const results: CodegenArtifact[] = [];
	declarations.emit(
		undefined,
		(_file, content, _bom, _onError, sourceFiles) => {
			const source = sourceFiles?.[0];
			if (!source || !within(resolve(root, generatedRoot), source.fileName))
				return;
			const path = relative(root, source.fileName)
				.split(sep)
				.join("/")
				.replace(/\.([cm]?)ts$/u, ".d.$1ts");
			content = rewriteImports(content, source, path, paths, options, host);
			results.push(create(CodegenArtifactSchema, { path, content }));
			if (path === `${generatedRoot}/app.d.ts`)
				results.push(
					create(CodegenArtifactSchema, {
						path: `${generatedRoot}/app.d.mts`,
						content,
					}),
				);
		},
		undefined,
		true,
	);
	return results;
}

export function declarationModuleSpecifier(from: string, to: string): string {
	return specifier(from, to);
}

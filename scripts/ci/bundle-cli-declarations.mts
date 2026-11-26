import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

export type DeclarationPackage = Readonly<{ name: string; root: string }>;
export type DeclarationImport = Readonly<{ source: string; published: string }>;
export type BundleCliDeclarationsInput = Readonly<{
	cliDist: string;
	packages: readonly DeclarationPackage[];
	publicImports: readonly DeclarationImport[];
	manifestDependencies: readonly string[];
	externalModules: string;
	outputFile: string;
	generatorFile?: string;
}>;

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function moduleSpecifiers(source: ts.SourceFile): ts.StringLiteralLike[] {
	const result: ts.StringLiteralLike[] = [];
	const walk = (node: ts.Node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		)
			result.push(node.moduleSpecifier);
		if (
			ts.isExternalModuleReference(node) &&
			node.expression !== undefined &&
			ts.isStringLiteralLike(node.expression)
		)
			result.push(node.expression);
		if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteralLike(node.argument.literal)
		)
			result.push(node.argument.literal);
		ts.forEachChild(node, walk);
	};
	walk(source);
	return result;
}

function copyDeclarationPackage(
	pkg: DeclarationPackage,
	modules: string,
): void {
	if (!PACKAGE_NAME.test(pkg.name))
		throw new Error(`Invalid package name: ${pkg.name}`);
	const sourceManifest = join(pkg.root, "package.json");
	const manifest: { name?: string } = JSON.parse(
		readFileSync(sourceManifest, "utf8"),
	);
	if (manifest.name !== pkg.name)
		throw new Error(`Package name mismatch for ${pkg.name}`);
	const output = join(modules, ...pkg.name.split("/"));
	mkdirSync(output, { recursive: true });
	cpSync(sourceManifest, join(output, "package.json"));
	const dist = join(pkg.root, "dist");
	if (!existsSync(join(dist, "index.d.ts")))
		throw new Error(`Missing built declarations for ${pkg.name}`);
	cpSync(dist, join(output, "dist"), { recursive: true, dereference: true });
	const generated = join(pkg.root, "src", "generated");
	if (existsSync(generated))
		cpSync(generated, join(output, "src", "generated"), {
			recursive: true,
			dereference: true,
		});
}

function linkExternalModules(
	source: string,
	target: string,
	packages: ReadonlySet<string>,
): void {
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (
			entry.name.startsWith(".") ||
			entry.name === "@hobo" ||
			entry.name === "@hobo-labs" ||
			packages.has(entry.name)
		)
			continue;
		symlinkSync(resolve(source, entry.name), join(target, entry.name), "dir");
	}
}

function rewritePublishedImports(
	content: string,
	aliases: readonly DeclarationImport[],
	manifestDependencies: ReadonlySet<string>,
): string {
	const source = ts.createSourceFile(
		"index.d.ts",
		content,
		ts.ScriptTarget.Latest,
		true,
	);
	if (source.referencedFiles.length > 0)
		throw new Error("CLI declaration bundle contains a file reference");
	for (const reference of source.typeReferenceDirectives) {
		const pkg = reference.fileName.startsWith("@types/")
			? reference.fileName
			: `@types/${reference.fileName}`;
		if (!manifestDependencies.has(pkg))
			throw new Error(`Declaration types absent from manifest: ${pkg}`);
	}
	const edits: { start: number; end: number; replacement: string }[] = [];
	for (const specifier of moduleSpecifiers(source)) {
		const name = specifier.text;
		if (name.startsWith("node:")) continue;
		const match = aliases.find(
			(alias) => name === alias.source || name.startsWith(`${alias.source}/`),
		);
		if (match === undefined)
			throw new Error(`Unpublished declaration import: ${name}`);
		if (!manifestDependencies.has(match.published))
			throw new Error(
				`Declaration import absent from manifest: ${match.published}`,
			);
		edits.push({
			start: specifier.getStart(source) + 1,
			end: specifier.getEnd() - 1,
			replacement: match.published + name.slice(match.source.length),
		});
	}
	let updated = content;
	for (const edit of edits.reverse())
		updated =
			updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
	return updated;
}

function assertKnownReferences(
	program: ts.Program,
	entry: string,
	packageRoots: readonly string[],
	known: ReadonlySet<string>,
): void {
	const roots = [dirname(entry), ...packageRoots];
	const builtins = new Set(builtinModules);
	for (const source of program.getSourceFiles()) {
		const inside = roots.some((root) => {
			const part = relative(root, source.fileName);
			return part !== "" && part !== ".." && !part.startsWith(`..${sep}`);
		});
		if (!inside) continue;
		for (const specifier of moduleSpecifiers(source)) {
			const name = specifier.text;
			if (
				name.startsWith(".") ||
				name.startsWith("node:") ||
				builtins.has(name)
			)
				continue;
			const parts = name.split("/");
			const pkg = name.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
			if (pkg === undefined || !known.has(pkg))
				throw new Error(`Unpublished declaration import: ${name}`);
		}
	}
}

function exportedNames(program: ts.Program, file: string): string[] {
	const source = program.getSourceFile(file);
	if (source === undefined)
		throw new Error(`Cannot load declaration entry: ${file}`);
	const checker = program.getTypeChecker();
	const module = checker.getSymbolAtLocation(source);
	if (module === undefined)
		throw new Error(`Declaration entry has no exports: ${file}`);
	return checker
		.getExportsOfModule(module)
		.map((item) => item.name)
		.sort();
}

export function bundleCliDeclarations(input: BundleCliDeclarationsInput): void {
	const names = new Set(input.packages.map((pkg) => pkg.name));
	if (names.size !== input.packages.length)
		throw new Error("Duplicate declaration package");
	const sources = new Set(input.publicImports.map((item) => item.source));
	if (sources.size !== input.publicImports.length)
		throw new Error("Duplicate public import");
	for (const alias of input.publicImports)
		if (!PACKAGE_NAME.test(alias.source) || !PACKAGE_NAME.test(alias.published))
			throw new Error("Invalid public declaration package");
	const generator =
		input.generatorFile ??
		createRequire(import.meta.url).resolve(
			"dts-bundle-generator/dist/bin/dts-bundle-generator.js",
		);
	const temp = mkdtempSync(join(tmpdir(), "hobo-cli-declarations-"));
	try {
		const modules = join(temp, "node_modules");
		mkdirSync(modules);
		linkExternalModules(input.externalModules, modules, names);
		for (const pkg of input.packages) copyDeclarationPackage(pkg, modules);
		const source = join(temp, "src");
		cpSync(input.cliDist, source, { recursive: true, dereference: true });
		const entry = join(source, "index.d.ts");
		if (!existsSync(entry))
			throw new Error("CLI root declarations are missing");
		const config = {
			strict: true,
			module: "NodeNext",
			moduleResolution: "NodeNext",
			target: "ES2022",
			skipLibCheck: true,
			types: ["node"],
		};
		const configFile = join(temp, "tsconfig.json");
		writeFileSync(
			join(temp, "package.json"),
			JSON.stringify({ name: "hobo-cli-types", type: "module" }),
		);
		writeFileSync(
			configFile,
			JSON.stringify({ compilerOptions: config, include: ["src"] }),
		);
		const output = join(temp, "index.d.ts");
		const options: ts.CompilerOptions = {
			strict: true,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ES2022,
			skipLibCheck: true,
			types: ["node"],
			noEmit: true,
		};
		const privateNames = [...names].filter((name) => !sources.has(name)).sort();
		const publicNames = [...sources].sort();
		const args = [
			generator,
			"--silent",
			"--no-check",
			"--export-referenced-types=false",
			"--project",
			configFile,
			"--out-file",
			output,
			"--external-imports",
			...publicNames,
			"--external-inlines",
			...privateNames,
			"--",
			entry,
		];
		const result = spawnSync(process.execPath, args, {
			cwd: temp,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
		if (result.status !== 0) {
			const detail =
				result.error?.message ??
				result.stderr ??
				result.stdout ??
				"unknown failure";
			throw new Error(
				`CLI declaration generation failed: ${detail.slice(-400)}`,
			);
		}
		const program = ts.createProgram([entry, output], options);
		assertKnownReferences(
			program,
			entry,
			input.packages.map((pkg) => join(modules, ...pkg.name.split("/"))),
			new Set([...names, ...sources]),
		);
		const before = exportedNames(program, entry);
		const after = exportedNames(program, output);
		if (JSON.stringify(before) !== JSON.stringify(after))
			throw new Error(
				"CLI declaration exports differ from the workspace entry",
			);
		const rewritten = rewritePublishedImports(
			readFileSync(output, "utf8"),
			input.publicImports,
			new Set(input.manifestDependencies),
		);
		for (const alias of input.publicImports) {
			if (alias.source === alias.published) continue;
			const sourcePath = join(modules, ...alias.source.split("/"));
			if (!existsSync(sourcePath)) continue;
			const target = join(modules, ...alias.published.split("/"));
			mkdirSync(dirname(target), { recursive: true });
			if (existsSync(target))
				throw new Error(`Duplicate published alias: ${alias.published}`);
			symlinkSync(sourcePath, target, "dir");
		}
		writeFileSync(output, rewritten);
		const publishedProgram = ts.createProgram([output], {
			...options,
			declaration: true,
			skipLibCheck: false,
		});
		const errors = ts.getPreEmitDiagnostics(publishedProgram);
		if (errors.length > 0)
			throw new Error(
				ts.formatDiagnosticsWithColorAndContext(errors, {
					getCanonicalFileName: (file) => file,
					getCurrentDirectory: () => temp,
					getNewLine: () => "\n",
				}),
			);
		const parent = dirname(input.outputFile);
		mkdirSync(parent, { recursive: true });
		const staged = join(parent, `.${process.pid}-cli-declarations.tmp`);
		try {
			writeFileSync(staged, rewritten, { flag: "wx" });
			renameSync(staged, input.outputFile);
		} finally {
			rmSync(staged, { force: true });
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

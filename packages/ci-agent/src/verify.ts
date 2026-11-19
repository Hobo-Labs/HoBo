import { createRequire } from "node:module";
import type TypeScript from "typescript";

const ts: typeof TypeScript = createRequire(import.meta.url)("typescript");

import { parseAllDocuments } from "yaml";

export type VerifyRefusal = "unparseable-resolution" | "duplicate-declaration";

export type ResolvedSides = Readonly<{
	path: string;
	ours: string;
	theirs: string;
	resolved: string;
}>;

const SCRIPT_KINDS = new Map([
	["ts", ts.ScriptKind.TS],
	["mts", ts.ScriptKind.TS],
	["cts", ts.ScriptKind.TS],
	["tsx", ts.ScriptKind.TSX],
	["js", ts.ScriptKind.JS],
	["mjs", ts.ScriptKind.JS],
	["cjs", ts.ScriptKind.JS],
	["jsx", ts.ScriptKind.JSX],
]);

const extension = (path: string) =>
	/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";

function scriptKind(path: string): TypeScript.ScriptKind | undefined {
	const kind = SCRIPT_KINDS.get(extension(path));
	return kind !== undefined && !/\.d\.[cm]?ts$/i.test(path) ? kind : undefined;
}

function parses(path: string, text: string): boolean | undefined {
	const kind = scriptKind(path);
	if (kind !== undefined)
		return (
			(
				ts.transpileModule(text, {
					fileName: path,
					reportDiagnostics: true,
					compilerOptions: {
						jsx: ts.JsxEmit.Preserve,
						target: ts.ScriptTarget.ESNext,
						module: ts.ModuleKind.ESNext,
					},
				}).diagnostics ?? []
			).length === 0
		);
	switch (extension(path)) {
		case "json":
			try {
				JSON.parse(text);
				return true;
			} catch {
				return false;
			}
		case "yaml":
		case "yml":
			try {
				return parseAllDocuments(text, {
					strict: true,
					uniqueKeys: true,
				}).every((document) => document.errors.length === 0);
			} catch {
				return false;
			}
		default:
			return undefined;
	}
}

function duplicateDeclarations(
	path: string,
	text: string,
): ReadonlySet<string> {
	const kind = scriptKind(path);
	if (kind === undefined) return new Set();
	const source = ts.createSourceFile(
		path,
		text,
		ts.ScriptTarget.Latest,
		false,
		kind,
	);
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	const declare = (name: string) => {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	};
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (clause?.name) declare(clause.name.text);
			const bindings = clause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings))
				declare(bindings.name.text);
			if (bindings && ts.isNamedImports(bindings))
				for (const element of bindings.elements) declare(element.name.text);
		} else if (ts.isFunctionDeclaration(statement)) {
			if (statement.name && statement.body) declare(statement.name.text);
		} else if (ts.isClassDeclaration(statement)) {
			if (statement.name) declare(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations)
				if (ts.isIdentifier(declaration.name)) declare(declaration.name.text);
		}
	}
	return duplicates;
}

export function verifyResolvedFile(
	sides: ResolvedSides,
): VerifyRefusal | undefined {
	const { path, ours, theirs, resolved } = sides;
	if (
		parses(path, ours) === true &&
		parses(path, theirs) === true &&
		parses(path, resolved) === false
	)
		return "unparseable-resolution";
	const before = new Set([
		...duplicateDeclarations(path, ours),
		...duplicateDeclarations(path, theirs),
	]);
	for (const name of duplicateDeclarations(path, resolved))
		if (!before.has(name)) return "duplicate-declaration";
	return undefined;
}

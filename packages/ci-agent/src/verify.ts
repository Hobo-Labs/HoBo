import ts from "typescript";
import { parse as parseYaml } from "yaml";

/** Why a resolved file was refused after it was put together. Fixed codes. */
export type VerifyRefusal = "unparseable-resolution" | "duplicate-declaration";

/** The whole file on each side of the merge, and the file the engine produced. */
export type ResolvedSides = Readonly<{
	path: string;
	ours: string;
	theirs: string;
	resolved: string;
}>;

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
	ts: ts.ScriptKind.TS,
	mts: ts.ScriptKind.TS,
	cts: ts.ScriptKind.TS,
	tsx: ts.ScriptKind.TSX,
	js: ts.ScriptKind.JS,
	mjs: ts.ScriptKind.JS,
	cjs: ts.ScriptKind.JS,
	jsx: ts.ScriptKind.JSX,
};

const extension = (path: string) =>
	/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";

function scriptKind(path: string): ts.ScriptKind | undefined {
	const kind = SCRIPT_KINDS[extension(path)];
	// A `.d.ts` file declares the same name more than once on purpose.
	return kind !== undefined && !/\.d\.[cm]?ts$/i.test(path) ? kind : undefined;
}

/** Whether a file of this kind parses. Undefined for a kind with no parser here. */
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
				parseYaml(text, { strict: true, uniqueKeys: true });
				return true;
			} catch {
				return false;
			}
		default:
			return undefined;
	}
}

/**
 * Names declared more than once at the top level of a script: imported
 * bindings, functions with a body, classes, and `let`/`const`/`var`
 * identifiers. Overload signatures, interfaces, namespaces and enums may
 * legally repeat and are not counted.
 */
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

/**
 * Checks a resolved file must pass before it is committed. A check only
 * refuses when both sides of the merge pass it, so a file that was already
 * unparseable, or a format with no parser here, never blocks a resolution.
 *
 * These are deterministic checks, not a judgement of the code: a resolution
 * that parses and declares each name once can still be wrong, and the
 * repository's required checks remain its verification.
 */
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

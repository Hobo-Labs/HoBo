/**
 * The module specifiers a source file names, read from its TypeScript syntax
 * tree.
 *
 * What is read, when the specifier is a string literal or a template literal
 * with no substitution:
 * - `import … from`, `import "…"`, `export … from`, `import x = require(…)`;
 * - `import(…)`, `require(…)`, `require.resolve(…)`, `import.meta.resolve(…)`;
 * - `createRequire(…)(…)`, and a name bound to `createRequire(…)`, where it is
 *   declared or by a later assignment (`let req; req = createRequire(…)`),
 *   called or `.resolve`d;
 * - `vi.mock`, `vi.doMock`, `vi.importActual` and `vi.importMock`, where `vi`
 *   is the global or a name vitest's `vi` is imported as (`import { vi as v }`);
 * - `typeof import(…)` in a type.
 *
 * What cannot be read, and is not: a specifier computed or substituted at run
 * time (`import(\`@hobo/${name}\`)`, `require(base + "/x")`), and a path built
 * for a child process or a URL (`spawn("node", [join(root, "dist/cli.js")])`,
 * `new URL("../dist/x.js", import.meta.url)`). A string that holds source text
 * is not an import either: the scanner sees one literal.
 */
import ts from "typescript";

export interface ImportSpecifier {
	/** The specifier as written. */
	readonly specifier: string;
	/** True where a compiler erases the import: `import type`, all-`type` named imports, `typeof import()`. */
	readonly typeOnly: boolean;
}

const VI_LOADERS = new Set(["mock", "doMock", "importActual", "importMock"]);

function literal(node: ts.Node | undefined): string | undefined {
	if (
		node !== undefined &&
		(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
	)
		return node.text;
	return undefined;
}

function scriptKind(fileName: string): ts.ScriptKind {
	if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
	if (/\.[cm]?js$/u.test(fileName)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

function isCreateRequire(node: ts.Expression): boolean {
	if (!ts.isCallExpression(node)) return false;
	const callee = node.expression;
	return (
		(ts.isIdentifier(callee) && callee.text === "createRequire") ||
		(ts.isPropertyAccessExpression(callee) &&
			callee.name.text === "createRequire")
	);
}

interface LoaderNames {
	/** `require`, and names bound to `createRequire(…)`. */
	readonly requires: Set<string>;
	/** `vi`, and names vitest's `vi` is imported as. */
	readonly vis: Set<string>;
	/** Names bound to `node:child_process`: a namespace or default import, or a `require`/`import()` of it. */
	readonly processes: Set<string>;
	/**
	 * Other names for a computed loader: `import { exec as run }`,
	 * `const run = cp.exec`, `const { exec: run } = cp`,
	 * `const execAsync = promisify(exec)`.
	 */
	readonly aliases: Set<string>;
}

const CHILD_PROCESS = new Set(["child_process", "node:child_process"]);

/** The expression under parentheses, `await`, `as`, `satisfies` and `!`. */
function unwrap(node: ts.Expression): ts.Expression {
	let inner = node;
	while (
		ts.isParenthesizedExpression(inner) ||
		ts.isAwaitExpression(inner) ||
		ts.isAsExpression(inner) ||
		ts.isSatisfiesExpression(inner) ||
		ts.isNonNullExpression(inner)
	)
		inner = inner.expression;
	return inner;
}

/** Whether `node` is `node:child_process`: a name bound to it, or a `require`/`import()` of it. */
function isChildProcess(node: ts.Expression, names: LoaderNames): boolean {
	const inner = unwrap(node);
	if (ts.isIdentifier(inner)) return names.processes.has(inner.text);
	if (!ts.isCallExpression(inner)) return false;
	const callee = inner.expression;
	return (
		(callee.kind === ts.SyntaxKind.ImportKeyword ||
			(ts.isIdentifier(callee) && names.requires.has(callee.text))) &&
		CHILD_PROCESS.has(literal(inner.arguments[0]) ?? "")
	);
}

/**
 * Whether `node` is a computed loader (`COMPUTED_LOADERS`): by its own name,
 * by an alias, as a method (`exec` only on `node:child_process`, since RegExp
 * has one too), promisified, or bound.
 */
function isLoader(node: ts.Expression, names: LoaderNames): boolean {
	const inner = unwrap(node);
	if (ts.isIdentifier(inner))
		return COMPUTED_LOADERS.has(inner.text) || names.aliases.has(inner.text);
	if (ts.isPropertyAccessExpression(inner)) {
		const method = inner.name.text;
		return (
			COMPUTED_LOADERS.has(method) &&
			(method !== "exec" || isChildProcess(inner.expression, names))
		);
	}
	return ts.isCallExpression(inner) && isPromisified(inner, names);
}

/** Whether the call makes a loader of one: `promisify(exec)`, `exec.bind(…)`. */
function isPromisified(node: ts.CallExpression, names: LoaderNames): boolean {
	const callee = node.expression;
	const first = node.arguments[0];
	if (ts.isPropertyAccessExpression(callee) && callee.name.text === "bind")
		return isLoader(callee.expression, names);
	return (
		calleeName(callee) === "promisify" &&
		first !== undefined &&
		isLoader(first, names)
	);
}

function boundCount(names: LoaderNames): number {
	return (
		names.requires.size +
		names.vis.size +
		names.processes.size +
		names.aliases.size
	);
}

/** The names that load a module or run a child process, bound anywhere in the file. */
function loaderNames(file: ts.SourceFile): LoaderNames {
	const names: LoaderNames = {
		requires: new Set(["require"]),
		vis: new Set(["vi"]),
		processes: new Set(),
		aliases: new Set(),
	};
	const bind = (name: string, value: ts.Expression) => {
		if (isCreateRequire(value)) names.requires.add(name);
		if (isChildProcess(value, names)) names.processes.add(name);
		if (isLoader(value, names)) names.aliases.add(name);
	};
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined
		)
			bind(node.name.text, node.initializer);
		else if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left)
		)
			bind(node.left.text, node.right);
		else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			CHILD_PROCESS.has(literal(node.moduleReference.expression) ?? "")
		)
			names.processes.add(node.name.text);
		else if (
			ts.isImportDeclaration(node) &&
			CHILD_PROCESS.has(literal(node.moduleSpecifier) ?? "")
		) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			if (clause?.name !== undefined) names.processes.add(clause.name.text);
			if (bindings !== undefined && ts.isNamespaceImport(bindings))
				names.processes.add(bindings.name.text);
		} else if (ts.isImportSpecifier(node)) {
			const imported = (node.propertyName ?? node.name).text;
			if (
				imported === "vi" &&
				literal(node.parent.parent.parent.moduleSpecifier) === "vitest"
			)
				names.vis.add(node.name.text);
			if (COMPUTED_LOADERS.has(imported)) names.aliases.add(node.name.text);
		} else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
			// `const { exec: run } = cp`
			const property = node.propertyName ?? node.name;
			if (ts.isIdentifier(property) && COMPUTED_LOADERS.has(property.text))
				names.aliases.add(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	// Again until nothing new is bound: a name may be bound to one bound later.
	let before = -1;
	while (before !== boundCount(names)) {
		before = boundCount(names);
		visit(file);
	}
	return names;
}

function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
	if (clause === undefined) return false;
	if (clause.isTypeOnly) return true;
	const bindings = clause.namedBindings;
	return (
		clause.name === undefined &&
		bindings !== undefined &&
		ts.isNamedImports(bindings) &&
		bindings.elements.length > 0 &&
		bindings.elements.every((element) => element.isTypeOnly)
	);
}

function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
	if (node.isTypeOnly) return true;
	const clause = node.exportClause;
	return (
		clause !== undefined &&
		ts.isNamedExports(clause) &&
		clause.elements.length > 0 &&
		clause.elements.every((element) => element.isTypeOnly)
	);
}

/** The specifier a call loads, if it is one of the loaders this reader knows. */
function calledSpecifier(
	node: ts.CallExpression,
	{ requires, vis }: LoaderNames,
): string | undefined {
	const callee = node.expression;
	const first = literal(node.arguments[0]);
	if (first === undefined) return undefined;
	if (callee.kind === ts.SyntaxKind.ImportKeyword) return first;
	if (ts.isIdentifier(callee))
		return requires.has(callee.text) ? first : undefined;
	if (isCreateRequire(callee)) return first;
	if (!ts.isPropertyAccessExpression(callee)) return undefined;
	const owner = callee.expression;
	const method = callee.name.text;
	if (
		method === "resolve" &&
		ts.isIdentifier(owner) &&
		requires.has(owner.text)
	)
		return first;
	if (method === "resolve" && isCreateRequire(owner)) return first;
	if (
		method === "resolve" &&
		ts.isMetaProperty(owner) &&
		owner.keywordToken === ts.SyntaxKind.ImportKeyword
	)
		return first;
	if (ts.isIdentifier(owner) && vis.has(owner.text) && VI_LOADERS.has(method))
		return first;
	return undefined;
}

/**
 * Stands in an assembled path for the part computed at run time: a template
 * literal's substitution, or a `join(…)`/`resolve(…)` argument that is not a
 * literal. It is not a character a path holds, so a literal `*` (a glob) stays
 * literal; the check shows it as `*`.
 */
export const COMPUTED = "\u0000";

/**
 * Stands for a computed part that is visibly a temporary directory: a call to
 * `tmpdir()`; `mkdtemp(prefix)` or `mkdtempSync(prefix)` where `prefix` is
 * itself one (`join(tmpdir(), "x-")`, `"/tmp/x-"`), since with any other
 * prefix the directory is made wherever the prefix names; a path built on one
 * (`join(tmpdir(), "x")`, `realpathSync(…)` of one) that has no `..`; a
 * literal under `/tmp/` with no `..`; or a name every binding of which in the
 * file is one. A parameter, a loop variable or a destructured name is not
 * visibly one. It is computed too.
 */
export const TEMPORARY = `${COMPUTED}\u0001`;

const TEMPORARY_LITERAL = /^\/tmp(?:\/|$)/u;

/** Whether path text has a `..` segment. */
const climbs = (text: string) => text.split(/[\\/]/u).includes("..");

/** Whether an assembled path starts at a temporary directory (`TEMPORARY`, or a literal `/tmp/…`). */
export function isTemporaryRooted(text: string): boolean {
	return text.startsWith(TEMPORARY) || TEMPORARY_LITERAL.test(text);
}

/**
 * Whether an assembled path stays under the temporary directory it starts at:
 * temporary-rooted, with no `..`. One that climbs (`${tmp}/../../packages`,
 * `/tmp/../repo`) may leave it, so it is read as a real path.
 */
export function isTemporaryPath(text: string): boolean {
	return isTemporaryRooted(text) && !climbs(text);
}

/** What a file names, read from one parse. */
export interface ModuleFacts {
	/** Every module specifier, in source order. */
	readonly imports: ImportSpecifier[];
	/**
	 * The path text it assembles: each string or template literal that is not an
	 * import specifier; each `join(…)`/`resolve(…)` call's arguments joined with
	 * `/`, a spread of an array literal, or of a name bound to one, read as its
	 * elements; and each `+` chain with a string in it, concatenated. A
	 * substitution, a non-literal argument or operand, or any other spread
	 * reads `COMPUTED`, or `TEMPORARY` where it is visibly a temporary
	 * directory.
	 */
	readonly paths: string[];
	/**
	 * Whether it runs or loads something by a path it computes: a child process
	 * (`spawn`, `exec`, `execFile`, `fork`, sync forms included), `import()` or
	 * `require` of a non-literal, `createRequire`, `symlink`, a copy (`cp`,
	 * `cpSync`, `fs.promises.cp`), or `new Worker`. A loader counts by its own
	 * name, under another (`import { exec as run }`, `const run = cp.exec`,
	 * `const { exec: run } = cp`), promisified or bound (`promisify(exec)`
	 * counts where it is made), and `exec` as a method only on a name bound to
	 * `node:child_process` (`cp.exec`), since RegExp has an `exec` too.
	 */
	readonly loadsComputed: boolean;
}

const COMPUTED_LOADERS = new Set([
	"spawn",
	"spawnSync",
	"exec",
	"execSync",
	"execFile",
	"execFileSync",
	"fork",
	"createRequire",
	"symlink",
	"symlinkSync",
	"cp",
	"cpSync",
]);
const PATH_BUILDERS = new Set(["join", "resolve"]);

function calleeName(node: ts.Expression): string | undefined {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	return undefined;
}

/** A literal's text, a substitution in it read by `part` (`COMPUTED` by default). */
function templateText(
	node: ts.Node,
	part: (expression: ts.Expression) => string = () => COMPUTED,
): string | undefined {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		return node.text;
	if (ts.isTemplateExpression(node))
		return [
			node.head.text,
			...node.templateSpans.map(
				(span) => `${part(span.expression)}${span.literal.text}`,
			),
		].join("");
	return undefined;
}

const TEMPORARY_MAKERS = new Set(["mkdtemp", "mkdtempSync"]);
/** Calls whose result is rooted where their first argument is. */
const ROOT_KEEPING = new Set([
	"join",
	"resolve",
	"normalize",
	"realpath",
	"realpathSync",
]);

/** Whether `node` is visibly a temporary directory (`TEMPORARY`), given the names that are. */
function isTemporary(node: ts.Expression, names: ReadonlySet<string>): boolean {
	const inner = unwrap(node);
	if (ts.isIdentifier(inner)) return names.has(inner.text);
	const text = literal(inner);
	if (text !== undefined) return isTemporaryPath(text);
	if (ts.isTemplateExpression(inner)) {
		const first = inner.templateSpans[0];
		const rest = inner.templateSpans.map((span) => span.literal.text);
		if ([inner.head.text, ...rest].some(climbs)) return false;
		return inner.head.text === "" && first !== undefined
			? isTemporary(first.expression, names)
			: TEMPORARY_LITERAL.test(inner.head.text);
	}
	if (isPlus(inner)) {
		const [head, ...rest] = operands(inner);
		return (
			!rest.some((operand) => climbs(literal(operand) ?? "")) &&
			isTemporary(head!, names)
		);
	}
	if (!ts.isCallExpression(inner)) return false;
	const name = calleeName(inner.expression);
	if (name === undefined) return false;
	if (name === "tmpdir") return true;
	const [first, ...rest] = inner.arguments;
	// mkdtemp makes its directory under its prefix, which must be temporary too.
	const under =
		first !== undefined &&
		!ts.isSpreadElement(first) &&
		isTemporary(first, names);
	if (TEMPORARY_MAKERS.has(name)) return under;
	return (
		ROOT_KEEPING.has(name) &&
		under &&
		!rest.some((argument) => climbs(literal(argument) ?? ""))
	);
}

/**
 * The names that are visibly a temporary directory: every binding of the name
 * in the file (a declaration's initializer, an assignment) is one. A name also
 * bound as a parameter, a loop variable or by destructuring is not.
 */
function temporaryNames(file: ts.SourceFile): Set<string> {
	// Each name's bindings; undefined for one whose value the file does not show.
	const bindings = new Map<string, (ts.Expression | undefined)[]>();
	const bind = (name: string, value: ts.Expression | undefined) => {
		bindings.set(name, [...(bindings.get(name) ?? []), value]);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			const statement = node.parent.parent;
			if (node.initializer !== undefined)
				bind(node.name.text, node.initializer);
			else if (ts.isForOfStatement(statement) || ts.isForInStatement(statement))
				bind(node.name.text, undefined);
		} else if (
			(ts.isParameter(node) || ts.isBindingElement(node)) &&
			ts.isIdentifier(node.name)
		)
			bind(node.name.text, undefined);
		else if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left)
		)
			bind(node.left.text, node.right);
		ts.forEachChild(node, visit);
	};
	visit(file);
	const names = new Set<string>();
	for (let grew = true; grew; ) {
		grew = false;
		for (const [name, values] of bindings)
			if (
				!names.has(name) &&
				values.every(
					(value) => value !== undefined && isTemporary(value, names),
				)
			) {
				names.add(name);
				grew = true;
			}
	}
	return names;
}

const isPlus = (node: ts.Node): node is ts.BinaryExpression =>
	ts.isBinaryExpression(node) &&
	node.operatorToken.kind === ts.SyntaxKind.PlusToken;

/** The operands of a `+` chain, through parentheses: `a + ("b" + c)` is `a`, `"b"`, `c`. */
function operands(node: ts.Expression): ts.Expression[] {
	let inner = node;
	while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
	return isPlus(inner)
		? [...operands(inner.left), ...operands(inner.right)]
		: [inner];
}

/** Whether a `+` sits inside another, through parentheses. */
function insidePlus(node: ts.Node): boolean {
	let parent = node.parent;
	while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
	return isPlus(parent);
}

/** The arrays a file binds to a name: `const segs = ["packages", "hobo"]`. */
function arrayBindings(
	file: ts.SourceFile,
): Map<string, ts.ArrayLiteralExpression> {
	const arrays = new Map<string, ts.ArrayLiteralExpression>();
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			ts.isArrayLiteralExpression(node.initializer)
		)
			arrays.set(node.name.text, node.initializer);
		ts.forEachChild(node, visit);
	};
	visit(file);
	return arrays;
}

/** What `source` names: its imports, the path text it assembles, and whether it loads by a computed path. */
export function readModule(source: string, fileName: string): ModuleFacts {
	const file = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKind(fileName),
	);
	const loaders = loaderNames(file);
	const arrays = arrayBindings(file);
	const temporary = temporaryNames(file);
	/** How a computed part reads: `TEMPORARY` where it is visibly a temporary directory. */
	const part = (expression: ts.Expression) =>
		isTemporary(expression, temporary) ? TEMPORARY : COMPUTED;
	/**
	 * Whether `node` is a later piece of a path rooted at a temporary directory
	 * (`join(tmp, "packages/hobo")`, `tmp + "/packages/hobo"`): that path is read
	 * whole, so the piece is not read as a path of its own.
	 */
	const inTemporaryPath = (node: ts.Node) => {
		const parent = node.parent;
		const first = ts.isCallExpression(parent) ? parent.arguments[0] : undefined;
		if (
			ts.isCallExpression(parent) &&
			ROOT_KEEPING.has(calleeName(parent.expression) ?? "") &&
			first !== undefined &&
			first !== node &&
			!ts.isSpreadElement(first) &&
			isTemporary(first, temporary)
		)
			return true;
		let chain: ts.Node | undefined;
		for (
			let up = node.parent;
			ts.isParenthesizedExpression(up) || isPlus(up);
			up = up.parent
		)
			if (isPlus(up)) chain = up;
		if (chain === undefined || !isPlus(chain)) return false;
		const head = operands(chain)[0]!;
		return head !== node && isTemporary(head, temporary);
	};
	/** An operand's text, and whether it was written as a literal. */
	const piece = (expression: ts.Expression) => {
		const text = templateText(expression, part);
		return { text: text ?? part(expression), literal: text !== undefined };
	};
	// A path builder's arguments, a spread of an array the file writes or binds
	// read as its elements (`join(root, ...segs)`), any other spread as computed.
	const segments = (args: readonly ts.Expression[]) =>
		args.flatMap((argument) => {
			if (!ts.isSpreadElement(argument)) return [piece(argument)];
			const spread = argument.expression;
			const array = ts.isArrayLiteralExpression(spread)
				? spread
				: ts.isIdentifier(spread)
					? arrays.get(spread.text)
					: undefined;
			return array === undefined
				? [{ text: COMPUTED, literal: false }]
				: array.elements.map((element) =>
						ts.isSpreadElement(element)
							? { text: COMPUTED, literal: false }
							: piece(element),
					);
		});
	const imports: ImportSpecifier[] = [];
	const paths: string[] = [];
	const specifiers = new Set<ts.Node>();
	let loadsComputed = false;
	const add = (node: ts.Node | undefined, typeOnly: boolean) => {
		const specifier = literal(node);
		if (node === undefined || specifier === undefined) return;
		specifiers.add(node);
		imports.push({ specifier, typeOnly });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node))
			add(node.moduleSpecifier, importClauseIsTypeOnly(node.importClause));
		else if (ts.isExportDeclaration(node))
			add(node.moduleSpecifier, exportIsTypeOnly(node));
		else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		)
			add(node.moduleReference.expression, node.isTypeOnly);
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			add(node.argument.literal, true);
		else if (ts.isCallExpression(node)) {
			if (calledSpecifier(node, loaders) !== undefined)
				add(node.arguments[0], false);
			const name = calleeName(node.expression);
			const loader =
				isLoader(node.expression, loaders) || isPromisified(node, loaders);
			const first = node.arguments[0];
			const computedArgument =
				first !== undefined && literal(first) === undefined;
			if (
				loader ||
				(computedArgument &&
					(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
						(ts.isIdentifier(node.expression) &&
							loaders.requires.has(node.expression.text))))
			)
				loadsComputed = true;
			const parts =
				name !== undefined && PATH_BUILDERS.has(name)
					? segments(node.arguments)
					: [];
			if (parts.length > 1 && parts.some((item) => item.literal))
				paths.push(parts.map((item) => item.text).join("/"));
		} else if (
			ts.isNewExpression(node) &&
			calleeName(node.expression) === "Worker"
		)
			loadsComputed = true;
		else if (isPlus(node) && !insidePlus(node)) {
			// A concatenation, `root + "/packages/" + name`, as one path.
			const parts = operands(node).map(piece);
			if (parts.some((item) => item.literal))
				paths.push(parts.map((item) => item.text).join(""));
		} else if (!specifiers.has(node)) {
			const text = templateText(node, part);
			if (text !== undefined && !inTemporaryPath(node)) paths.push(text);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return { imports, paths, loadsComputed };
}

/** Every module specifier `source` names, in source order. */
export function importSpecifiersOf(
	source: string,
	fileName: string,
): ImportSpecifier[] {
	return readModule(source, fileName).imports;
}

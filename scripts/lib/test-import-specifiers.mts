import ts from "typescript";

export interface ImportSpecifier {
	readonly specifier: string;
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
	readonly requires: Set<string>;
	readonly vis: Set<string>;
	readonly processes: Set<string>;
	readonly aliases: Set<string>;
}

const CHILD_PROCESS = new Set(["child_process", "node:child_process"]);

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
			const property = node.propertyName ?? node.name;
			if (ts.isIdentifier(property) && COMPUTED_LOADERS.has(property.text))
				names.aliases.add(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
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

export const COMPUTED = "\u0000";

export const TEMPORARY = `${COMPUTED}\u0001`;

const TEMPORARY_LITERAL = /^\/tmp(?:\/|$)/u;

const climbs = (text: string) => text.split(/[\\/]/u).includes("..");

export function isTemporaryRooted(text: string): boolean {
	return text.startsWith(TEMPORARY) || TEMPORARY_LITERAL.test(text);
}

export function isTemporaryPath(text: string): boolean {
	return isTemporaryRooted(text) && !climbs(text);
}

export interface ModuleFacts {
	readonly imports: ImportSpecifier[];
	readonly paths: string[];
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
const ROOT_KEEPING = new Set([
	"join",
	"resolve",
	"normalize",
	"realpath",
	"realpathSync",
]);

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

function temporaryNames(file: ts.SourceFile): Set<string> {
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

function operands(node: ts.Expression): ts.Expression[] {
	let inner = node;
	while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
	return isPlus(inner)
		? [...operands(inner.left), ...operands(inner.right)]
		: [inner];
}

function insidePlus(node: ts.Node): boolean {
	let parent = node.parent;
	while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
	return isPlus(parent);
}

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
	const part = (expression: ts.Expression) =>
		isTemporary(expression, temporary) ? TEMPORARY : COMPUTED;
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
	const piece = (expression: ts.Expression) => {
		const text = templateText(expression, part);
		return { text: text ?? part(expression), literal: text !== undefined };
	};
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

export function importSpecifiersOf(
	source: string,
	fileName: string,
): ImportSpecifier[] {
	return readModule(source, fileName).imports;
}

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode, encode } from "@jridgewell/sourcemap-codec";
import ts from "typescript";

type Edit = {
	readonly start: number;
	readonly end: number;
	readonly replacement: string;
	readonly line: number;
	readonly column: number;
};

function mappedSpecifier(
	value: string,
	packages: Readonly<Record<string, string>>,
) {
	if (!value.startsWith("@hobo/")) return undefined;
	const slash = value.indexOf("/", "@hobo/".length);
	const packageName = slash < 0 ? value : value.slice(0, slash);
	const mapped = packages[packageName];
	return mapped === undefined
		? undefined
		: mapped + (slash < 0 ? "" : value.slice(slash));
}

export function rewriteSdkSpecifiers(
	file: string,
	text: string,
	packages: Readonly<Record<string, string>>,
) {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const edits: Edit[] = [];
	let requireBound = false;
	const bindsRequire = (name: ts.Node): boolean => {
		if (ts.isIdentifier(name)) return name.text === "require";
		if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
			return name.elements.some(
				(element) => ts.isBindingElement(element) && bindsRequire(element.name),
			);
		return false;
	};
	const findRequireBinding = (node: ts.Node) => {
		if (
			(ts.isVariableDeclaration(node) ||
				ts.isParameter(node) ||
				ts.isFunctionDeclaration(node) ||
				ts.isClassDeclaration(node) ||
				ts.isImportClause(node) ||
				ts.isImportSpecifier(node) ||
				ts.isNamespaceImport(node) ||
				ts.isImportEqualsDeclaration(node)) &&
			node.name !== undefined &&
			bindsRequire(node.name)
		)
			requireBound = true;
		if (
			ts.isBinaryExpression(node) &&
			ts.isIdentifier(node.left) &&
			node.left.text === "require" &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		)
			requireBound = true;
		ts.forEachChild(node, findRequireBinding);
	};
	findRequireBinding(source);
	const pushEdit = (start: number, end: number, replacement: string) => {
		if (/[\r\n]/u.test(text.slice(start, end)))
			throw new Error("multiline SDK module specifiers are unsupported");
		const position = source.getLineAndCharacterOfPosition(start);
		edits.push({
			start,
			end,
			replacement,
			line: position.line,
			column: position.character,
		});
	};
	const add = (node: ts.Node | undefined) => {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const mapped = mappedSpecifier(node.text, packages);
		if (mapped === undefined) return;
		const start = node.getStart(source);
		const end = node.getEnd();
		pushEdit(start, end, JSON.stringify(mapped));
	};
	for (const reference of source.typeReferenceDirectives) {
		const mapped = mappedSpecifier(reference.fileName, packages);
		if (mapped !== undefined) pushEdit(reference.pos, reference.end, mapped);
	}
	const visit = (node: ts.Node) => {
		if (
			ts.isPropertyAssignment(node) &&
			((ts.isIdentifier(node.name) && node.name.text === "runtimeModule") ||
				(ts.isStringLiteralLike(node.name) &&
					node.name.text === "runtimeModule"))
		)
			add(node.initializer);
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			add(node.moduleSpecifier);
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			add(node.argument.literal);
		if (ts.isExternalModuleReference(node)) add(node.expression);
		if (ts.isCallExpression(node)) {
			const expression = node.expression;
			const requireCall =
				(ts.isIdentifier(expression) && expression.text === "require") ||
				(ts.isPropertyAccessExpression(expression) &&
					ts.isIdentifier(expression.expression) &&
					expression.expression.text === "require" &&
					expression.name.text === "resolve");
			if (
				requireCall &&
				requireBound &&
				node.arguments[0] &&
				ts.isStringLiteralLike(node.arguments[0]) &&
				mappedSpecifier(node.arguments[0].text, packages) !== undefined
			)
				throw new Error("ambiguous SDK require binding");
			if (
				expression.kind === ts.SyntaxKind.ImportKeyword ||
				requireCall ||
				(ts.isPropertyAccessExpression(expression) &&
					ts.isMetaProperty(expression.expression) &&
					expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
					expression.expression.name.text === "meta" &&
					expression.name.text === "resolve")
			)
				add(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	edits.sort((left, right) => left.start - right.start);
	let result = "";
	let previous = 0;
	for (const edit of edits) {
		result += text.slice(previous, edit.start) + edit.replacement;
		previous = edit.end;
	}
	return { text: result + text.slice(previous), edits };
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: source-map JSON is checked at its file boundary. */
export function rewriteSdkSourceMap(
	mapText: string,
	edits: readonly Edit[],
): string {
	const map: unknown = JSON.parse(mapText);
	if (
		typeof map !== "object" ||
		map === null ||
		!("mappings" in map) ||
		typeof map.mappings !== "string"
	)
		throw new Error("unsupported SDK source map");
	const lines = decode(map.mappings);
	for (let line = 0; line < lines.length; line++) {
		const lineEdits = edits.filter((edit) => edit.line === line);
		for (const segment of lines[line] ?? []) {
			const originalColumn = segment[0];
			let shift = 0;
			for (const edit of lineEdits) {
				const length = edit.end - edit.start;
				if (originalColumn >= edit.column + length)
					shift += edit.replacement.length - length;
				else if (originalColumn > edit.column) {
					shift +=
						Math.min(originalColumn - edit.column, edit.replacement.length) -
						(originalColumn - edit.column);
					break;
				} else break;
			}
			segment[0] = originalColumn + shift;
		}
	}
	map.mappings = encode(lines);
	return `${JSON.stringify(map)}\n`;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

export function rewriteStagedSdkDirectory(
	directory: string,
	packages: Readonly<Record<string, string>>,
): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isSymbolicLink())
			throw new Error("SDK distribution symlinks are unsupported");
		if (entry.isDirectory()) {
			rewriteStagedSdkDirectory(file, packages);
			continue;
		}
		if (!entry.isFile() || !/\.(?:[cm]?js|d\.[cm]?ts)$/u.test(entry.name))
			continue;
		const text = readFileSync(file, "utf8");
		const result = rewriteSdkSpecifiers(file, text, packages);
		if (result.edits.length === 0) continue;
		const references = [
			...text.matchAll(/^\s*\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/gmu),
		];
		if (
			references.length > 1 ||
			(references[0] && references[0][1] !== `${entry.name}.map`)
		)
			throw new Error("unsupported SDK source map reference");
		const mapFile = `${file}.map`;
		try {
			const map = readFileSync(mapFile, "utf8");
			writeFileSync(mapFile, rewriteSdkSourceMap(map, result.edits));
		} catch (error) {
			if (
				references.length > 0 ||
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		writeFileSync(file, result.text);
	}
}

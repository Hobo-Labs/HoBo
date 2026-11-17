import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { create } from "@bufbuild/protobuf";
import * as ts from "typescript";

import {
	type PatternApplicationPlan,
	PatternApplicationPlanSchema,
	type PatternApplicationReceipt,
	PatternApplicationReceiptSchema,
	ReceiptStatus,
} from "./_generated/patterns_pb.js";
import type { PatternCatalog } from "./catalog.js";
import { PatternParseError, parseApplicationRequest } from "./parse.js";
import { renderPattern } from "./render.js";

function assertSafe(root: string, rel: string): string {
	if (rel.startsWith("/") || rel.includes("..")) {
		throw new PatternParseError(`unsafe path ${rel}`);
	}
	const resolved = normalize(join(root, rel));
	if (!resolved.startsWith(normalize(root))) {
		throw new PatternParseError(`path escapes root: ${rel}`);
	}
	return resolved;
}

function parseTs(text: string, fileName: string): ts.SourceFile {
	return ts.createSourceFile(
		fileName,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}

function syntaxError(text: string, fileName: string): string | undefined {
	const transpile = ts.transpileModule(text, {
		compilerOptions: {
			target: ts.ScriptTarget.Latest,
			module: ts.ModuleKind.ESNext,
		},
		fileName,
		reportDiagnostics: true,
	});
	const first = transpile.diagnostics?.find(
		(item) => item.category === ts.DiagnosticCategory.Error,
	);
	return first
		? ts.flattenDiagnosticMessageText(first.messageText, "\n")
		: undefined;
}

function isBindleCall(node: ts.Node): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "bindle"
	);
}

function bindleCalls(sf: ts.SourceFile): ts.CallExpression[] {
	const hits: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (isBindleCall(node)) hits.push(node);
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return hits;
}

function callbackOf(
	call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
	for (const arg of call.arguments) {
		if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg;
	}
	return undefined;
}

function callbackBlock(
	fn: ts.ArrowFunction | ts.FunctionExpression,
): ts.Block | undefined {
	return ts.isBlock(fn.body) ? fn.body : undefined;
}

function printNode(node: ts.Node, sf: ts.SourceFile): string {
	return ts
		.createPrinter({ newLine: ts.NewLineKind.LineFeed })
		.printNode(ts.EmitHint.Unspecified, node, sf);
}

function namedImportsFrom(
	sf: ts.SourceFile,
	moduleName: string,
): { decl: ts.ImportDeclaration; names: Set<string> } | undefined {
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt)) continue;
		if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
		if (stmt.moduleSpecifier.text !== moduleName) continue;
		const clause = stmt.importClause?.namedBindings;
		if (!clause || !ts.isNamedImports(clause)) continue;
		return {
			decl: stmt,
			names: new Set(clause.elements.map((el) => el.name.text)),
		};
	}
	return undefined;
}

function declaredNames(block: ts.Block): Set<string> {
	const names = new Set<string>();
	for (const stmt of block.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		for (const decl of stmt.declarationList.declarations) {
			if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
		}
	}
	return names;
}

function returnObject(block: ts.Block): ts.ObjectLiteralExpression | undefined {
	for (const stmt of block.statements) {
		if (!ts.isReturnStatement(stmt) || !stmt.expression) continue;
		if (ts.isObjectLiteralExpression(stmt.expression)) return stmt.expression;
	}
	return undefined;
}

function returnPropertyNames(literal: ts.ObjectLiteralExpression): Set<string> {
	const names = new Set<string>();
	for (const prop of literal.properties) {
		if (ts.isShorthandPropertyAssignment(prop)) names.add(prop.name.text);
		if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
			names.add(prop.name.text);
		}
	}
	return names;
}

function allocateName(base: string, used: Set<string>): string {
	if (!used.has(base)) return base;
	let n = 2;
	while (used.has(`${base}${n}`)) n += 1;
	return `${base}${n}`;
}

/** A snippet split into the imports it names and the statements it adds. */
type UnwrappedSnippet = {
	readonly imports: ReadonlyMap<string, readonly string[]>;
	readonly statements: readonly ts.Statement[];
	readonly sourceFile: ts.SourceFile;
};

function unwrapSnippetFile(text: string): UnwrappedSnippet {
	const sf = parseTs(text, "snippet.ts");
	const imports = new Map<string, string[]>();
	const statements: ts.Statement[] = [];
	for (const stmt of sf.statements) {
		if (
			ts.isImportDeclaration(stmt) &&
			ts.isStringLiteral(stmt.moduleSpecifier)
		) {
			const names =
				stmt.importClause?.namedBindings &&
				ts.isNamedImports(stmt.importClause.namedBindings)
					? stmt.importClause.namedBindings.elements.map((el) => el.name.text)
					: [];
			imports.set(stmt.moduleSpecifier.text, names);
			continue;
		}
		if (ts.isExportAssignment(stmt) && stmt.expression) {
			const expr = stmt.expression;
			if (isBindleCall(expr)) {
				const cb = callbackOf(expr);
				const block = cb ? callbackBlock(cb) : undefined;
				if (block) {
					for (const inner of block.statements) {
						if (ts.isReturnStatement(inner)) continue;
						statements.push(inner);
					}
				}
				continue;
			}
		}
		statements.push(stmt);
	}
	if (statements.length === 0 && !text.includes("bindle(")) {
		const wrapped = parseTs(`function __snippet() {\n${text}\n}`, "wrap.ts");
		const fn = wrapped.statements[0];
		if (fn && ts.isFunctionDeclaration(fn) && fn.body) {
			statements.push(...fn.body.statements);
		}
	}
	return { imports, statements, sourceFile: sf };
}

function insertText(source: string, pos: number, addition: string): string {
	return source.slice(0, pos) + addition + source.slice(pos);
}

function applyStructural(previous: string, snippet: string): string {
	const error = syntaxError(snippet, "snippet.ts");
	if (error) {
		throw new PatternParseError(`snippet is not valid TypeScript: ${error}`);
	}
	if (previous.trim() === "")
		return snippet.endsWith("\n") ? snippet : `${snippet}\n`;

	const existingError = syntaxError(previous, "target.ts");
	if (existingError) {
		throw new PatternParseError(
			`target has source syntax errors: ${existingError}`,
		);
	}

	const sf = parseTs(previous, "target.ts");
	const calls = bindleCalls(sf);
	if (calls.length > 1) {
		throw new PatternParseError("multiple ambiguous Bindle definitions");
	}
	if (calls.length === 0) {
		if (
			previous.includes("bindle(") ||
			previous.includes('from "@hobo/bindles"')
		) {
			throw new PatternParseError(
				"dynamic code shapes that cannot be safely transformed",
			);
		}
		throw new PatternParseError("unsupported existing TypeScript shape");
	}

	const call = calls[0];
	if (!call) {
		throw new PatternParseError("unsupported existing TypeScript shape");
	}
	const cb = callbackOf(call);
	const block = cb ? callbackBlock(cb) : undefined;
	if (!cb || !block) {
		throw new PatternParseError("unsupported existing TypeScript shape");
	}

	const extracted = unwrapSnippetFile(snippet);
	let next = previous;
	let shift = 0;
	const adjust = (pos: number): number => pos + shift;

	const existingBindles = namedImportsFrom(sf, "@hobo/bindles");
	const wantedBindleNames = extracted.imports.get("@hobo/bindles") ?? [];
	if (wantedBindleNames.length > 0) {
		if (!existingBindles) {
			const importLine = `import { ${[...new Set(wantedBindleNames)].sort().join(", ")} } from "@hobo/bindles";\n`;
			const insertAt = sf.statements[0]?.getStart(sf) ?? 0;
			next = insertText(next, adjust(insertAt), importLine);
			shift += importLine.length;
		} else {
			const missing = wantedBindleNames.filter(
				(name) => !existingBindles.names.has(name),
			);
			if (missing.length > 0) {
				const clause = existingBindles.decl.importClause?.namedBindings;
				if (clause && ts.isNamedImports(clause)) {
					const last = clause.elements[clause.elements.length - 1];
					const insertAt = last ? last.end : clause.end - 1;
					const addition = `, ${missing.join(", ")}`;
					next = insertText(next, adjust(insertAt), addition);
					shift += addition.length;
				}
			}
		}
	}

	const used = declaredNames(block);
	const returnLit = returnObject(block);
	const returnNames = returnLit
		? returnPropertyNames(returnLit)
		: new Set<string>();
	const newStatements: string[] = [];
	const newReturnNames: string[] = [];

	for (const stmt of extracted.statements) {
		if (
			ts.isExpressionStatement(stmt) &&
			ts.isCallExpression(stmt.expression)
		) {
			const callExpr = stmt.expression;
			if (
				ts.isPropertyAccessExpression(callExpr.expression) &&
				ts.isIdentifier(callExpr.expression.expression)
			) {
				const owner = callExpr.expression.expression.text;
				const method = callExpr.expression.name.text;
				if (method === "dependsOn" || method === "with" || method === "allow") {
					const printed = printNode(callExpr, extracted.sourceFile);
					if (next.includes(printed)) continue;
					const ownerDecl = block.statements.find((item) => {
						if (!ts.isVariableStatement(item)) return false;
						return item.declarationList.declarations.some(
							(decl) => ts.isIdentifier(decl.name) && decl.name.text === owner,
						);
					});
					if (!ownerDecl || !ts.isVariableStatement(ownerDecl)) {
						throw new PatternParseError(`unresolved symbol ${owner}`);
					}
					const decl = ownerDecl.declarationList.declarations.find(
						(item) => ts.isIdentifier(item.name) && item.name.text === owner,
					);
					if (!decl?.initializer) {
						throw new PatternParseError(`unresolved symbol ${owner}`);
					}
					const initText = previous.slice(
						decl.initializer.getStart(sf),
						decl.initializer.end,
					);
					if (initText.includes(`.${method}(`)) continue;
					const addition = `.${method}(${callExpr.arguments.map((arg) => printNode(arg, extracted.sourceFile)).join(", ")})`;
					next = insertText(next, adjust(decl.initializer.end), addition);
					shift += addition.length;
					continue;
				}
			}
		}

		if (ts.isVariableStatement(stmt)) {
			const decl = stmt.declarationList.declarations[0];
			if (!decl || !ts.isIdentifier(decl.name)) {
				throw new PatternParseError("unsupported existing TypeScript shape");
			}
			const wanted = decl.name.text;
			const printedInit = decl.initializer
				? printNode(decl.initializer, extracted.sourceFile)
				: "";
			const already = block.statements.find((item) => {
				if (!ts.isVariableStatement(item)) return false;
				return item.declarationList.declarations.some((existing) => {
					if (!ts.isIdentifier(existing.name)) return false;
					if (existing.name.text !== wanted) return false;
					if (!existing.initializer) return false;
					return (
						printNode(existing.initializer, sf).replace(/\s+/g, " ") ===
						printedInit.replace(/\s+/g, " ")
					);
				});
			});
			if (already) continue;
			const name = allocateName(wanted, used);
			used.add(name);
			const stmtText = printNode(stmt, extracted.sourceFile);
			const rewritten =
				name === wanted ? stmtText : stmtText.replace(wanted, name);
			newStatements.push(rewritten);
			if (!returnNames.has(name)) newReturnNames.push(name);
			continue;
		}

		const printed = printNode(stmt, extracted.sourceFile).trim();
		if (printed && !next.includes(printed)) {
			newStatements.push(printed);
		}
	}

	if (newStatements.length > 0) {
		const ret = block.statements.find(ts.isReturnStatement);
		const insertAt = ret ? ret.getStart(sf) : block.end - 1;
		const addition = `${newStatements.join("\n")}\n  `;
		next = insertText(next, adjust(insertAt), addition);
		shift += addition.length;
	}

	if (returnLit && newReturnNames.length > 0) {
		const close = returnLit.end - 1;
		const prefix = returnLit.properties.length > 0 ? ", " : "";
		const addition = `${prefix}${newReturnNames.join(", ")}`;
		next = insertText(next, adjust(close), addition);
		shift += addition.length;
	}

	const reparsed = syntaxError(next, "target.ts");
	if (reparsed) {
		throw new PatternParseError(
			`transformed TypeScript is invalid: ${reparsed}`,
		);
	}
	const again = parseTs(next, "target.ts");
	if (bindleCalls(again).length !== 1) {
		throw new PatternParseError("multiple ambiguous Bindle definitions");
	}
	return next;
}

/**
 * `P` is whatever the caller's params hold. `parseApplicationRequest` accepts
 * any scalar and coerces it to a string, and refuses anything else, so the
 * accepted type stays as wide as that parser.
 */
export function planPatternApplication<P>(input: {
	readonly catalog: PatternCatalog;
	readonly patternId: string;
	readonly isolationRoot: string;
	readonly targetPath: string;
	readonly isolationRunId: string;
	readonly params?: Readonly<Record<string, P>>;
}): PatternApplicationPlan {
	const parsed = parseApplicationRequest({
		patternId: input.patternId,
		isolationRoot: input.isolationRoot,
		targetPath: input.targetPath,
		isolationRunId: input.isolationRunId,
		params: input.params ?? {},
	});
	assertSafe(parsed.isolationRoot, parsed.targetPath);
	const pattern = input.catalog.patterns.find(
		(item) => item.id === parsed.patternId,
	);
	if (!pattern) {
		throw new PatternParseError(`unknown pattern ${parsed.patternId}`);
	}
	let preimage = "";
	try {
		preimage = createHash("sha256")
			.update(
				readFileSync(
					assertSafe(parsed.isolationRoot, parsed.targetPath),
					"utf8",
				),
			)
			.digest("hex");
	} catch {
		preimage = "";
	}
	return create(PatternApplicationPlanSchema, {
		isolationRunId: parsed.isolationRunId,
		sourceRoot: parsed.isolationRoot,
		targetPath: parsed.targetPath,
		expectedPreimage: preimage ? [preimage] : [],
		effects: pattern.effects,
		promotionRequired: true,
	});
}

export function applyPatternPlan<P>(input: {
	readonly catalog: PatternCatalog;
	readonly patternId: string;
	readonly isolationRoot: string;
	readonly targetPath: string;
	readonly isolationRunId: string;
	readonly params?: Readonly<Record<string, P>>;
}): PatternApplicationReceipt {
	const plan = planPatternApplication(input);
	const pattern = input.catalog.patterns.find(
		(item) => item.id === input.patternId,
	);
	if (!pattern) {
		throw new PatternParseError(`unknown pattern ${input.patternId}`);
	}
	const rendered = input.params
		? renderPattern({ catalog: input.catalog, pattern, params: input.params })
		: renderPattern({ catalog: input.catalog, pattern });
	const changed: string[] = [];
	const postimage: string[] = [];
	let allIdempotent = true;
	for (const [index, file] of rendered.files.entries()) {
		const rel =
			rendered.files.length === 1 ? input.targetPath || file.path : file.path;
		const target = assertSafe(input.isolationRoot, rel);
		mkdirSync(dirname(target), { recursive: true });
		let previous = "";
		try {
			previous = readFileSync(target, "utf8");
		} catch {
			previous = "";
		}
		const merged =
			index === 0 &&
			(file.contents.includes("bindle(") || previous.includes("bindle("))
				? applyStructural(previous, file.contents)
				: previous.includes(file.contents.trim())
					? previous
					: previous.trim() === ""
						? file.contents
						: (() => {
								throw new PatternParseError(
									"unsupported language or non-TypeScript merge",
								);
							})();
		if (merged !== previous) {
			writeFileSync(target, merged);
			changed.push(rel);
			allIdempotent = false;
		}
		postimage.push(createHash("sha256").update(merged).digest("hex"));
	}
	void plan;
	return create(PatternApplicationReceiptSchema, {
		isolationRunId: input.isolationRunId,
		changedFiles: changed,
		postimage,
		idempotent: allIdempotent,
		promotionRequired: true,
		promotionRef: "caller-promotes",
		llmCalls: 0,
		llmInputTokens: 0,
		llmOutputTokens: 0,
		status: ReceiptStatus.ACCEPTED,
		reasonCode: allIdempotent ? "idempotent" : "applied-isolation",
	});
}

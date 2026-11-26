import { readFile } from "node:fs/promises";

import {
	type DeclaredTrainableClass,
	scanDeclaredTrainables,
} from "ts-autocode-grounding";
import ts from "typescript";
import { isPlainIdentifier, isReservedWord } from "./identifiers.js";
import { MARKERS, mayHoldMarkedClass } from "./marker-prefilter.js";
import { projectPath, scannedSources } from "./source-files.js";
import { CodegenError, type CodegenLayout } from "./types.js";

export interface AmbientTrainableClass {
	readonly file: string;
	readonly declared: DeclaredTrainableClass;
}

interface MarkedClass {
	readonly className: string;
	readonly ambient: boolean;
	readonly text: string;
}

const WINDOWS_DEVICE =
	/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/iu;
function isMarked(node: ts.ClassDeclaration | ts.ClassExpression): boolean {
	return (
		ts.getDecorators(node)?.some((decorator) => {
			const callee = ts.isCallExpression(decorator.expression)
				? decorator.expression.expression
				: decorator.expression;
			return ts.isIdentifier(callee) && MARKERS.has(callee.text);
		}) ?? false
	);
}

function isOuterExpression(
	node: ts.Node,
): node is
	| ts.ParenthesizedExpression
	| ts.AsExpression
	| ts.SatisfiesExpression
	| ts.NonNullExpression
	| ts.TypeAssertion
	| ts.ExpressionWithTypeArguments {
	return (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isExpressionWithTypeArguments(node)
	);
}

function skipOuterExpressions(node: ts.Expression): ts.Expression {
	let inner = node;
	while (isOuterExpression(inner)) inner = inner.expression;
	return inner;
}

const NAMING_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
	ts.SyntaxKind.EqualsToken,
	ts.SyntaxKind.AmpersandAmpersandEqualsToken,
	ts.SyntaxKind.BarBarEqualsToken,
	ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function propertyKeyName(name: ts.PropertyName): string | undefined {
	const key = ts.isComputedPropertyName(name)
		? skipOuterExpressions(name.expression)
		: name;
	if (
		ts.isIdentifier(key) ||
		ts.isPrivateIdentifier(key) ||
		ts.isStringLiteral(key) ||
		ts.isNoSubstitutionTemplateLiteral(key)
	) {
		return key.text;
	}
	return ts.isNumericLiteral(key) ? String(Number(key.text)) : undefined;
}

function namedEvaluation(holder: ts.Node, value: ts.Node): string | undefined {
	if (
		(ts.isVariableDeclaration(holder) ||
			ts.isBindingElement(holder) ||
			ts.isParameter(holder)) &&
		holder.initializer === value
	) {
		return ts.isIdentifier(holder.name) ? holder.name.text : undefined;
	}
	if (
		ts.isBinaryExpression(holder) &&
		holder.right === value &&
		NAMING_ASSIGNMENTS.has(holder.operatorToken.kind)
	) {
		const target = skipOuterExpressions(holder.left);
		return ts.isIdentifier(target) ? target.text : undefined;
	}
	if (ts.isShorthandPropertyAssignment(holder)) {
		return holder.objectAssignmentInitializer === value
			? holder.name.text
			: undefined;
	}
	if (
		(ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) &&
		holder.initializer === value
	) {
		return propertyKeyName(holder.name);
	}
	if (ts.isExportAssignment(holder) && !holder.isExportEquals) {
		return "default";
	}
	return undefined;
}

function registeredName(
	node: ts.ClassDeclaration | ts.ClassExpression,
): string | undefined {
	if (node.name !== undefined) return node.name.text;
	if (ts.isClassDeclaration(node)) {
		return node.modifiers?.some(
			(modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
		)
			? "default"
			: undefined;
	}
	let value: ts.Node = node;
	while (isOuterExpression(value.parent)) value = value.parent;
	return namedEvaluation(value.parent, value);
}

function markedClasses(source: string): readonly MarkedClass[] {
	const sourceFile = ts.createSourceFile(
		"source.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const found: MarkedClass[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
			isMarked(node)
		) {
			const className = registeredName(node);
			const ambient =
				node.modifiers?.some(
					(modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
				) ?? false;
			if (className !== undefined) {
				found.push({
					className,
					ambient,
					text: source.slice(node.getStart(sourceFile), node.end),
				});
			}
			if (ambient) return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

function scanAmbient(
	file: string,
	marked: MarkedClass,
): DeclaredTrainableClass {
	let classes: readonly DeclaredTrainableClass[];
	try {
		classes = scanDeclaredTrainables(marked.text);
	} catch (error) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`Cannot scan the ambient @trainable class ${marked.className} in ${file}: ${error instanceof Error ? error.message : error}`,
			{ file, className: marked.className },
		);
	}
	const [declared] = classes;
	if (
		classes.length !== 1 ||
		declared === undefined ||
		!declared.ambient ||
		declared.className !== marked.className
	) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`ts-autocode-grounding does not scan ${marked.className} in ${file} as one ambient @trainable class`,
			{ file, className: marked.className },
		);
	}
	for (const { method } of declared.operations) {
		const why = isReservedWord(method)
			? "a reserved word"
			: method === "defineGrounding"
				? "the name it imports defineGrounding by"
				: undefined;
		if (why !== undefined) {
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				`Ambient @trainable class ${marked.className} in ${file} has a method named ${method}, which declared/${marked.className}.ts cannot export as a const (${why}); rename the method`,
				{ file, className: marked.className, method },
			);
		}
	}
	return declared;
}

function refuseModuleName(
	found: readonly AmbientTrainableClass[],
	file: string,
	className: string,
): void {
	if (!isPlainIdentifier(className)) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`Ambient @trainable class ${className} in ${file} is not a plain ASCII identifier; codegen names its module file and exports from it, and would drop letters; rename the class`,
			{ file, className },
		);
	}
	if (WINDOWS_DEVICE.test(className)) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`Ambient @trainable class ${className} in ${file} cannot have a registration module: Windows reserves the file name ${className}.ts for a device; rename the class`,
			{ file, className },
		);
	}
	const earlier = found.find(
		(entry) =>
			entry.declared.className.toLowerCase() === className.toLowerCase(),
	);
	if (earlier === undefined) return;
	const earlierName = earlier.declared.className;
	throw new CodegenError(
		"HOBO_CODEGEN_SOURCE_PARSE",
		earlierName === className
			? `Ambient @trainable class ${className} is declared in both ${earlier.file} and ${file}; its method refs would collide`
			: `Ambient @trainable classes ${earlierName} (${earlier.file}) and ${className} (${file}) differ only in case; declared/${earlierName}.ts and declared/${className}.ts are one file on a case-insensitive file system`,
		{ file, className, earlier: earlier.file },
	);
}

export async function scanAmbientTrainableClasses(
	projectRoot: string,
	layout: CodegenLayout,
): Promise<readonly AmbientTrainableClass[]> {
	const sources = await Promise.all(
		(await scannedSources(projectRoot, layout)).map(async (path) => ({
			file: projectPath(projectRoot, path),
			source: await readFile(path, "utf8"),
		})),
	);
	return scanAmbientTrainableSources(sources);
}

export function scanAmbientTrainableSources(
	sources: readonly { readonly file: string; readonly source: string }[],
): readonly AmbientTrainableClass[] {
	const found: AmbientTrainableClass[] = [];
	const decorated = new Map<string, string>();
	for (const { file, source } of sources) {
		if (!mayHoldMarkedClass(source)) continue;
		for (const marked of markedClasses(source)) {
			if (!marked.ambient) {
				if (!decorated.has(marked.className)) {
					decorated.set(marked.className, file);
				}
				continue;
			}
			refuseModuleName(found, file, marked.className);
			found.push({ file, declared: scanAmbient(file, marked) });
		}
	}
	for (const { file, declared } of found) {
		const other = decorated.get(declared.className);
		if (other !== undefined) {
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				`Ambient @trainable class ${declared.className} in ${file} shares its name with the decorated @trainable class in ${other}; both register ${declared.className}.<method>, and one registration would silently replace the other`,
				{ file, className: declared.className, decorated: other },
			);
		}
	}
	return found;
}

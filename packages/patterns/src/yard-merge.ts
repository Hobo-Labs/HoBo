import * as ts from "typescript";
import { PatternParseError } from "./parse.js";

type YardDefinition = {
	file: ts.SourceFile;
	options: ts.ObjectLiteralExpression;
	name: string;
	binding?: string;
};

function parseSource(text: string, filename: string): ts.SourceFile {
	const result = ts.transpileModule(text, {
		fileName: filename,
		compilerOptions: { module: ts.ModuleKind.ESNext },
		reportDiagnostics: true,
	});
	if (
		result.diagnostics?.some(
			(item) => item.category === ts.DiagnosticCategory.Error,
		)
	) {
		throw new PatternParseError("yard source has invalid TypeScript");
	}
	return ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
}

function parseYard(text: string, filename: string): YardDefinition {
	const file = parseSource(text, filename);
	const definitions: ts.CallExpression[] = [];
	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "yard"
		)
			definitions.push(node);
		ts.forEachChild(node, visit);
	}
	visit(file);
	const call = definitions[0];
	const name = call?.arguments[0];
	const options = call?.arguments[1];
	if (
		definitions.length !== 1 ||
		call?.arguments.length !== 2 ||
		!name ||
		!ts.isStringLiteral(name) ||
		!options ||
		!ts.isObjectLiteralExpression(options)
	) {
		throw new PatternParseError(
			"expected one statically named yard with literal options",
		);
	}
	const owner = file.statements
		.flatMap((statement) =>
			ts.isVariableStatement(statement)
				? [...statement.declarationList.declarations]
				: [],
		)
		.find((declaration) => declaration.initializer === call);
	if (!owner || !ts.isIdentifier(owner.name))
		throw new PatternParseError("yard must have a top-level binding");
	return { file, options, name: name.text, binding: owner.name.text };
}

function parseCampFragment(text: string): YardDefinition {
	const file = parseSource(text, "camp-fragment.ts");
	const statements = file.statements.filter(
		(statement) => !ts.isImportDeclaration(statement),
	);
	const statement = statements[0];
	if (
		statements.length !== 1 ||
		!statement ||
		!ts.isVariableStatement(statement) ||
		statement.declarationList.declarations.length !== 1
	)
		throw new PatternParseError("camp fragment contains unrelated statements");
	const declaration = statement.declarationList.declarations[0];
	if (
		!declaration ||
		!ts.isIdentifier(declaration.name) ||
		declaration.name.text !== "placement" ||
		!declaration.initializer ||
		!ts.isObjectLiteralExpression(declaration.initializer)
	)
		throw new PatternParseError("expected a literal camp placement");
	const fields = declaration.initializer.properties;
	if (
		fields.length !== 2 ||
		fields.some(
			(field) =>
				!ts.isPropertyAssignment(field) ||
				!ts.isIdentifier(field.name) ||
				!["yardName", "camps"].includes(field.name.text),
		)
	)
		throw new PatternParseError("camp placement has unsupported fields");
	const yardName = fields.find(
		(field) =>
			ts.isPropertyAssignment(field) &&
			ts.isIdentifier(field.name) &&
			field.name.text === "yardName",
	);
	const camps = fields.find(
		(field) =>
			ts.isPropertyAssignment(field) &&
			ts.isIdentifier(field.name) &&
			field.name.text === "camps",
	);
	if (
		!yardName ||
		!ts.isPropertyAssignment(yardName) ||
		!ts.isStringLiteral(yardName.initializer) ||
		!camps ||
		!ts.isPropertyAssignment(camps)
	)
		throw new PatternParseError("camp placement is incomplete");
	return {
		file,
		name: yardName.initializer.text,
		options: ts.factory.createObjectLiteralExpression([camps]),
	};
}

function properties(
	object: ts.ObjectLiteralExpression,
	allowOther: boolean,
): Map<string, ts.PropertyAssignment> {
	const result = new Map<string, ts.PropertyAssignment>();
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name))
			throw new PatternParseError("unsupported yard property");
		const name = property.name.text;
		if (
			(!allowOther && !["provider", "network", "camps"].includes(name)) ||
			result.has(name)
		)
			throw new PatternParseError(
				`unsupported or duplicate yard property ${name}`,
			);
		result.set(name, property);
	}
	return result;
}

function arrayValues(
	property: ts.PropertyAssignment,
	name: string,
): Map<string, ts.Expression> {
	if (!ts.isArrayLiteralExpression(property.initializer))
		throw new PatternParseError(`yard ${name} must be a literal array`);
	const values = new Map<string, ts.Expression>();
	for (const value of property.initializer.elements) {
		if (name === "network" && ts.isStringLiteral(value))
			values.set(value.text, ts.factory.createStringLiteral(value.text));
		else if (
			name === "camps" &&
			ts.isCallExpression(value) &&
			ts.isIdentifier(value.expression) &&
			value.expression.text === "camp" &&
			value.arguments.length === 1 &&
			value.arguments[0] &&
			ts.isStringLiteral(value.arguments[0])
		)
			values.set(
				value.arguments[0].text,
				ts.factory.createCallExpression(
					ts.factory.createIdentifier("camp"),
					undefined,
					[ts.factory.createStringLiteral(value.arguments[0].text)],
				),
			);
		else throw new PatternParseError(`yard ${name} contains a dynamic value`);
	}
	return values;
}

function imports(file: ts.SourceFile): Map<string, Set<string>> {
	const found = new Map<string, Set<string>>();
	for (const statement of file.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier)
		)
			continue;
		const moduleName = statement.moduleSpecifier.text;
		if (moduleName !== "@hobo/yards" && moduleName !== "@hobo/camps") continue;
		const clause = statement.importClause;
		const names = clause?.namedBindings;
		if (
			!clause ||
			clause.isTypeOnly ||
			clause.name ||
			!names ||
			!ts.isNamedImports(names) ||
			names.elements.some((item) => item.isTypeOnly || item.propertyName)
		)
			throw new PatternParseError(`unsupported ${moduleName} import`);
		const set = found.get(moduleName) ?? new Set<string>();
		for (const name of names.elements) set.add(name.name.text);
		found.set(moduleName, set);
	}
	return found;
}

export function mergeYardTopology(previous: string, incoming: string): string {
	const target = parseYard(previous, "yard.ts");
	const addition = incoming.includes("yard(")
		? parseYard(incoming, "yard-fragment.ts")
		: parseCampFragment(incoming);
	if (target.name !== addition.name)
		throw new PatternParseError("yard names differ");
	if (addition.binding && target.binding !== addition.binding)
		throw new PatternParseError("yard bindings differ");
	if (
		addition.file.statements.some(
			(statement) =>
				ts.isImportDeclaration(statement) &&
				(!ts.isStringLiteral(statement.moduleSpecifier) ||
					!["@hobo/yards", "@hobo/camps"].includes(
						statement.moduleSpecifier.text,
					)),
		)
	)
		throw new PatternParseError("yard fragment contains an unrelated import");
	if (
		addition.binding &&
		addition.file.statements.some(
			(statement) =>
				!ts.isImportDeclaration(statement) &&
				!(
					ts.isVariableStatement(statement) &&
					statement.declarationList.declarations.length === 1 &&
					statement.declarationList.declarations[0]?.initializer &&
					ts.isCallExpression(
						statement.declarationList.declarations[0].initializer,
					) &&
					ts.isIdentifier(
						statement.declarationList.declarations[0].initializer.expression,
					) &&
					statement.declarationList.declarations[0].initializer.expression
						.text === "yard"
				),
		)
	)
		throw new PatternParseError("yard fragment contains unrelated statements");
	const original = properties(target.options, true);
	const fragment = properties(addition.options, false);
	const targetImports = imports(target.file);
	const fragmentImports = imports(addition.file);
	if (
		!targetImports.get("@hobo/yards")?.has("yard") ||
		(addition.binding && !fragmentImports.get("@hobo/yards")?.has("yard"))
	)
		throw new PatternParseError("yard import is missing");
	const targetProvider = original.get("provider");
	if (targetProvider && !ts.isStringLiteral(targetProvider.initializer))
		throw new PatternParseError("yard provider must be a literal string");
	for (const name of ["network", "camps"]) {
		const targetProperty = original.get(name);
		const fragmentProperty = fragment.get(name);
		if (targetProperty) arrayValues(targetProperty, name);
		if (fragmentProperty) arrayValues(fragmentProperty, name);
	}
	const targetCamps = original.get("camps");
	const fragmentCamps = fragment.get("camps");
	if (
		targetCamps &&
		arrayValues(targetCamps, "camps").size > 0 &&
		!targetImports.get("@hobo/camps")?.has("camp")
	)
		throw new PatternParseError("camp import is missing");
	if (
		fragmentCamps &&
		arrayValues(fragmentCamps, "camps").size > 0 &&
		!fragmentImports.get("@hobo/camps")?.has("camp")
	)
		throw new PatternParseError("camp import is missing");
	for (const [moduleName, names] of fragmentImports) {
		const supported = moduleName === "@hobo/yards" ? "yard" : "camp";
		if ([...names].some((name) => name !== supported))
			throw new PatternParseError("yard fragment contains an unrelated import");
	}
	const merged = [...target.options.properties];
	let changed = false;
	for (const [name, property] of fragment) {
		const existing = original.get(name);
		if (name === "provider") {
			if (
				!ts.isStringLiteral(property.initializer) ||
				(existing && !ts.isStringLiteral(existing.initializer))
			)
				throw new PatternParseError("yard provider must be a literal string");
			if (existing) {
				if (
					!ts.isStringLiteral(existing.initializer) ||
					existing.initializer.text !== property.initializer.text
				)
					throw new PatternParseError("yard provider conflicts");
			} else {
				merged.push(
					ts.factory.createPropertyAssignment(
						"provider",
						ts.factory.createStringLiteral(property.initializer.text),
					),
				);
				changed = true;
			}
			continue;
		}
		const values = arrayValues(property, name);
		if (!existing) {
			merged.push(
				ts.factory.createPropertyAssignment(
					name,
					ts.factory.createArrayLiteralExpression([...values.values()]),
				),
			);
			changed = true;
			continue;
		}
		const present = arrayValues(existing, name);
		const additions = [...values]
			.filter(([key]) => !present.has(key))
			.map(([, value]) => value);
		if (additions.length) {
			const index = merged.indexOf(existing);
			if (!ts.isArrayLiteralExpression(existing.initializer))
				throw new PatternParseError(`yard ${name} must be a literal array`);
			merged[index] = ts.factory.updatePropertyAssignment(
				existing,
				existing.name,
				ts.factory.updateArrayLiteralExpression(existing.initializer, [
					...existing.initializer.elements,
					...additions,
				]),
			);
			changed = true;
		}
	}
	const missingImports = [...fragmentImports].flatMap(([moduleName, names]) =>
		[...names]
			.filter((name) => !targetImports.get(moduleName)?.has(name))
			.map((name) => ({ moduleName, name })),
	);
	for (const { name } of missingImports) {
		let collision = false;
		function findIdentifier(node: ts.Node): void {
			if (ts.isIdentifier(node) && node.text === name) collision = true;
			ts.forEachChild(node, findIdentifier);
		}
		findIdentifier(target.file);
		if (collision)
			throw new PatternParseError(
				`yard import ${name} conflicts with an existing identifier`,
			);
	}
	if (!changed && missingImports.length === 0) return previous;
	const transformed = ts.transform(target.file, [
		(context) => (source) => {
			const visit: ts.Visitor = (node) =>
				node === target.options
					? ts.factory.updateObjectLiteralExpression(target.options, merged)
					: ts.visitEachChild(node, visit, context);
			return ts.visitEachChild(source, visit, context);
		},
	]);
	const file = transformed.transformed[0];
	if (!file) throw new PatternParseError("yard transformation failed");
	const addedImports = missingImports.map(({ moduleName, name }) =>
		ts.factory.createImportDeclaration(
			undefined,
			ts.factory.createImportClause(
				false,
				undefined,
				ts.factory.createNamedImports([
					ts.factory.createImportSpecifier(
						false,
						undefined,
						ts.factory.createIdentifier(name),
					),
				]),
			),
			ts.factory.createStringLiteral(moduleName),
		),
	);
	const updated = ts.factory.updateSourceFile(file, [
		...addedImports,
		...file.statements,
	]);
	const result = ts
		.createPrinter({ newLine: ts.NewLineKind.LineFeed })
		.printFile(updated);
	transformed.dispose();
	return result;
}

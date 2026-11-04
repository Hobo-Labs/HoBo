import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { DesignScorecardRow } from "../../src/design-scorecard.mts";

export type DesignScorecardEvidenceResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; reason: string }>;

function failure(reason: string): DesignScorecardEvidenceResult {
	return { ok: false, reason };
}

function isWithin(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path !== "" &&
		!path.startsWith(`..${sep}`) &&
		path !== ".." &&
		!isAbsolute(path)
	);
}

function jsonProperty(
	object: ts.ObjectLiteralExpression,
	name: string,
): ts.Expression | undefined {
	return object.properties.find(
		(property): property is ts.PropertyAssignment =>
			ts.isPropertyAssignment(property) &&
			(ts.isIdentifier(property.name) ||
				ts.isStringLiteralLike(property.name)) &&
			property.name.text === name,
	)?.initializer;
}

function packageRunsVitest(manifestPath: string): boolean {
	const manifest = ts.parseJsonText(
		manifestPath,
		readFileSync(manifestPath, "utf8"),
	);
	const root = manifest.statements[0]?.expression;
	if (root === undefined || !ts.isObjectLiteralExpression(root)) return false;
	const scripts = jsonProperty(root, "scripts");
	if (scripts === undefined || !ts.isObjectLiteralExpression(scripts))
		return false;
	const test = jsonProperty(scripts, "test");
	return (
		test !== undefined &&
		ts.isStringLiteralLike(test) &&
		test.text === "vitest run"
	);
}

function findPackageDirectory(
	filePath: string,
	repoRoot: string,
): string | undefined {
	let directory = dirname(filePath);
	while (isWithin(repoRoot, directory)) {
		if (existsSync(resolve(directory, "package.json"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
	return undefined;
}

function staticName(node: ts.CallExpression): string | undefined {
	const name = node.arguments[0];
	return name !== undefined && ts.isStringLiteralLike(name)
		? name.text
		: undefined;
}

function declarationOf(
	node: ts.CallExpression,
): Readonly<{ name: string; modifiers: string[] }> | undefined {
	let expression: ts.Expression = node.expression;
	const modifiers: string[] = [];
	while (
		ts.isCallExpression(expression) ||
		ts.isPropertyAccessExpression(expression)
	) {
		if (ts.isCallExpression(expression)) {
			expression = expression.expression;
		} else {
			modifiers.push(expression.name.text);
			expression = expression.expression;
		}
	}
	return ts.isIdentifier(expression)
		? { name: expression.text, modifiers }
		: undefined;
}

function matchesTestName(fullName: string, pattern: string): boolean {
	if (fullName.includes(pattern)) return true;
	try {
		return new RegExp(pattern).test(fullName);
	} catch {
		return false;
	}
}

export function checkDesignScorecardEvidence(
	repoRoot: string,
	row: DesignScorecardRow,
): DesignScorecardEvidenceResult {
	const evidencePath = resolve(repoRoot, row.evidenceFile);
	if (
		!isWithin(repoRoot, evidencePath) ||
		!existsSync(evidencePath) ||
		!statSync(evidencePath).isFile()
	) {
		return failure(`evidence file does not exist: ${row.evidenceFile}`);
	}

	const packageDirectory = findPackageDirectory(evidencePath, repoRoot);
	if (packageDirectory === undefined) {
		return failure(`no owning package.json for ${row.evidenceFile}`);
	}
	if (!packageRunsVitest(resolve(packageDirectory, "package.json"))) {
		return failure(`owning package does not run Vitest: ${row.evidenceFile}`);
	}
	const packageRelativePath = relative(packageDirectory, evidencePath);
	if (
		!packageRelativePath.startsWith(`test${sep}`) &&
		!packageRelativePath.startsWith(`contracts${sep}`)
	) {
		return failure(
			`evidence file is outside the owning package test/contracts directories: ${row.evidenceFile}`,
		);
	}
	if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(evidencePath)) {
		return failure(
			`evidence file is excluded by Vitest's default includes: ${row.evidenceFile}`,
		);
	}

	const source = ts.createSourceFile(
		evidencePath,
		readFileSync(evidencePath, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const suiteNames: string[] = [];
	const tests: { fullName: string; skipped: boolean; only: boolean }[] = [];
	function visit(node: ts.Node, suiteSkipped = false, suiteOnly = false): void {
		if (ts.isCallExpression(node)) {
			const declaration = declarationOf(node);
			const name = staticName(node);
			if (declaration?.name === "describe" && name !== undefined) {
				const skipped =
					suiteSkipped ||
					declaration.modifiers.some(
						(modifier) => modifier === "skip" || modifier === "todo",
					);
				const only = suiteOnly || declaration.modifiers.includes("only");
				suiteNames.push(name);
				ts.forEachChild(node, (child) => visit(child, skipped, only));
				suiteNames.pop();
				return;
			}
			if (
				(declaration?.name === "it" || declaration?.name === "test") &&
				name !== undefined
			) {
				const skipped =
					suiteSkipped ||
					declaration.modifiers.some(
						(modifier) => modifier === "skip" || modifier === "todo",
					);
				tests.push({
					fullName: [...suiteNames, name].join(" "),
					skipped,
					only: suiteOnly || declaration.modifiers.includes("only"),
				});
			}
		}
		ts.forEachChild(node, (child) => visit(child, suiteSkipped, suiteOnly));
	}
	visit(source);
	const hasOnly = tests.some((test) => !test.skipped && test.only);
	const found = tests.some(
		(test) =>
			!test.skipped &&
			(!hasOnly || test.only) &&
			matchesTestName(test.fullName, row.evidenceTest),
	);
	return found
		? { ok: true }
		: failure(
				`no enabled test matches ${JSON.stringify(row.evidenceTest)} in ${row.evidenceFile}`,
			);
}

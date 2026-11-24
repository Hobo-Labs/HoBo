#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type MovedTestMode = "exact" | "assertions";

export interface MovedTestRow {
	readonly outcome: string;
	readonly base: string;
	readonly next: string;
	readonly mode: MovedTestMode;
	readonly helpers: readonly string[] | "any";
	readonly lane: string;
}

export interface MovedTestResult extends MovedTestRow {
	readonly differences: readonly string[];
}

export const BASE_REF = "fleet-wave-0";

export const MOVED_TESTS: readonly MovedTestRow[] = [
	{
		outcome: "O15",
		base: "packages/data-postgres/test/fleet-assignment.test.ts",
		next: "packages/fleet/test/assignment/register.test.ts",
		mode: "exact",
		helpers: ["entry", "writer"],
		lane: "L05",
	},
	{
		outcome: "O15",
		base: "packages/data-postgres/test/fleet-model.ts",
		next: "packages/fleet/test/assignment/fleet-model.ts",
		mode: "exact",
		helpers: [],
		lane: "L05",
	},
	{
		outcome: "O15",
		base: "packages/backend-routing/test/ephemeral-replica.test.ts",
		next: "packages/fleet/test/assignment/ephemeral-replica.test.ts",
		mode: "exact",
		helpers: [],
		lane: "L05",
	},
	{
		outcome: "O15",
		base: "packages/backend-routing/test/fixtures.ts",
		next: "packages/fleet/test/assignment/fixtures.ts",
		mode: "exact",
		helpers: [],
		lane: "L05",
	},
	{
		outcome: "O15",
		base: "packages/backend-routing/test/replica-pact.test.ts",
		next: "packages/fleet/test/assignment/replica-pact.test.ts",
		mode: "exact",
		helpers: [],
		lane: "L05",
	},
	{
		outcome: "O15",
		base: "packages/backend-routing/test/replica-pact.ts",
		next: "packages/fleet/test/assignment/replica-pact.ts",
		mode: "exact",
		helpers: [],
		lane: "L05",
	},
	{
		outcome: "O16",
		base: "packages/ci-vercel/test/cache-fleet.test.ts",
		next: "packages/ci-vercel/test/cache-fleet.test.ts",
		mode: "exact",
		helpers: ["member", "world"],
		lane: "L17",
	},
	{
		outcome: "O16",
		base: "packages/ci-vercel/test/cache-backend.test.ts",
		next: "packages/ci-vercel/test/cache-backend.test.ts",
		mode: "exact",
		helpers: [],
		lane: "L17",
	},
	{
		outcome: "O17",
		base: "packages/data-postgres/test/fleet-policy.test.ts",
		next: "packages/data-postgres/test/fleet-policy.test.ts",
		mode: "assertions",
		helpers: "any",
		lane: "L21",
	},
	{
		outcome: "O17",
		base: "packages/backend-routing/test/routing.test.ts",
		next: "packages/backend-routing/test/routing.test.ts",
		mode: "assertions",
		helpers: "any",
		lane: "L21",
	},
];

export const RENAME_MAP = {
	PostgresFleetAssignment: "AssignmentEntry",
	FleetAssignment: "AssignmentEntry",
	FleetAssignmentValue: "AssignmentValue",
	parseFleetAssignment: "parseAssignmentEntry",
	parseFleetBackendId: "parseMemberName",
	FleetObservation: "NamedObservation",
	PostgresFleetObservation: "NamedObservation",
	FleetRoutingObservation: "NamedObservation",
	FleetFailureClass: "Health",
	FleetBackendHealth: "Health",
	FleetFailureClassifier: "FailureClassifier",
	CacheFleetTick: "OneActiveTick",
	[`@hobo/backend-${"fleet"}`]: "@hobo/backend-routing",
} as const satisfies Readonly<Record<string, string>>;

const renames = new Map<string, string>(Object.entries(RENAME_MAP));

export const VALUE_MAP = {
	reachable: "Health.REACHABLE",
	unreachable: "Health.UNREACHABLE",
	"quota-exhausted": "Health.QUOTA_EXHAUSTED",
	auth: "Health.AUTH",
	unknown: "Health.UNKNOWN",
} as const satisfies Readonly<Record<string, string>>;

const values = new Map<string, string>(Object.entries(VALUE_MAP));

const VALUE_KEYS = new Set(["failure", "health"]);
const TEST_CALLS = new Set(["describe", "it", "test"]);
const BODY_CALLS = new Set(["it", "test"]);

type Side = "base" | "new";

interface Token {
	readonly text: string;
	readonly line: number;
}

interface Options {
	readonly side: Side;
	readonly helpers?: ReadonlySet<string>;
}

function parse(name: string, text: string): ts.SourceFile {
	return ts.createSourceFile(
		name,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
	return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function renameSpecifier(text: string): string {
	for (const [from, to] of renames)
		if (from.startsWith("@") && (text === from || text.startsWith(`${from}/`)))
			return to + text.slice(from.length);
	return text;
}

function nameText(name: ts.Node | undefined): string | undefined {
	if (name === undefined) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
	return undefined;
}

function isStringish(
	node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isModuleRelativeUrl(
	node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
): boolean {
	const call = node.parent;
	if (
		call === undefined ||
		!ts.isNewExpression(call) ||
		!ts.isIdentifier(call.expression) ||
		call.expression.text !== "URL"
	)
		return false;
	const [path, base] = call.arguments ?? [];
	return (
		path === node &&
		/^\.\.?\//u.test(node.text) &&
		base !== undefined &&
		ts.isPropertyAccessExpression(base) &&
		ts.isMetaProperty(base.expression) &&
		base.name.text === "url"
	);
}

function calleeName(call: ts.CallExpression): string | undefined {
	return ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

const snippetTokens = new Map<string, readonly string[]>();

function snippet(expression: string): readonly string[] {
	let tokens = snippetTokens.get(expression);
	if (tokens === undefined) {
		const sf = parse("snippet.ts", `(${expression});`);
		const statement = sf.statements[0];
		const out: Token[] = [];
		if (
			statement !== undefined &&
			ts.isExpressionStatement(statement) &&
			ts.isParenthesizedExpression(statement.expression)
		)
			walk(statement.expression.expression, sf, { side: "new" }, out);
		tokens = out.map((token) => token.text);
		snippetTokens.set(expression, tokens);
	}
	return tokens;
}

function isDroppedMembers(property: ts.ObjectLiteralElementLike): boolean {
	return (
		ts.isPropertyAssignment(property) &&
		nameText(property.name) === "members" &&
		ts.isIdentifier(property.initializer) &&
		property.initializer.text === "undefined"
	);
}

function walk(
	node: ts.Node,
	sf: ts.SourceFile,
	options: Options,
	out: Token[],
): void {
	const kind = node.kind;
	if (
		kind >= ts.SyntaxKind.FirstJSDocNode &&
		kind <= ts.SyntaxKind.LastJSDocNode
	)
		return;
	if (
		kind === ts.SyntaxKind.CommaToken ||
		kind === ts.SyntaxKind.SemicolonToken
	)
		return;
	const line = lineOf(sf, node);
	const push = (text: string): void => {
		out.push({ text, line });
	};
	const helpers = options.helpers;

	if (helpers !== undefined) {
		if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node))
			return;
		if (
			ts.isFunctionDeclaration(node) &&
			node.name &&
			helpers.has(node.name.text)
		) {
			push(`helper:${node.name.text}`);
			return;
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			helpers.has(node.name.text)
		) {
			push(`helper:${node.name.text}`);
			return;
		}
	}

	if (ts.isIdentifier(node)) {
		const text =
			options.side === "base"
				? (renames.get(node.text) ?? node.text)
				: node.text;
		push(`id:${text}`);
		return;
	}
	if (ts.isPrivateIdentifier(node)) {
		push(`id:${node.text}`);
		return;
	}
	if (isStringish(node) && isModuleRelativeUrl(node)) {
		push(`url:${node.text.replace(/^(?:\.\.?\/)+/u, "")}`);
		return;
	}
	if (isStringish(node)) {
		push(
			`str:${options.side === "base" ? renameSpecifier(node.text) : node.text}`,
		);
		return;
	}
	if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
		push(`num:${node.text}`);
		return;
	}
	if (ts.isRegularExpressionLiteral(node)) {
		push(`re:${node.text}`);
		return;
	}
	if (
		ts.isTemplateHead(node) ||
		ts.isTemplateMiddle(node) ||
		ts.isTemplateTail(node)
	) {
		push(`${ts.SyntaxKind[kind]}:${node.text}`);
		return;
	}

	if (
		options.side === "base" &&
		ts.isPropertyAssignment(node) &&
		VALUE_KEYS.has(nameText(node.name) ?? "") &&
		isStringish(node.initializer) &&
		values.has(node.initializer.text)
	) {
		push(`k:${ts.SyntaxKind[kind]}`);
		walk(node.name, sf, options, out);
		push("k:ColonToken");
		const mapped = values.get(node.initializer.text) ?? "";
		const at = lineOf(sf, node.initializer);
		for (const text of snippet(mapped)) out.push({ text, line: at });
		return;
	}

	if (options.side === "new" && ts.isCallExpression(node)) {
		const [argument] = node.arguments;
		if (
			calleeName(node) === "parseMemberName" &&
			node.arguments.length === 1 &&
			argument !== undefined &&
			isStringish(argument)
		) {
			walk(argument, sf, options, out);
			return;
		}
	}
	const dropMembers =
		options.side === "new" &&
		ts.isObjectLiteralExpression(node) &&
		ts.isCallExpression(node.parent) &&
		calleeName(node.parent) === "parseAssignmentEntry" &&
		node.parent.arguments.includes(node);

	push(`k:${ts.SyntaxKind[kind]}`);
	for (const child of node.getChildren(sf)) {
		if (child.kind === ts.SyntaxKind.SyntaxList && dropMembers) {
			out.push({ text: "k:SyntaxList", line: lineOf(sf, child) });
			for (const element of child.getChildren(sf))
				if (
					!(ts.isObjectLiteralElementLike(element) && isDroppedMembers(element))
				)
					walk(element, sf, options, out);
			continue;
		}
		walk(child, sf, options, out);
	}
}

function tokens(name: string, text: string, options: Options): Token[] {
	const sf = parse(name, text);
	const out: Token[] = [];
	for (const statement of sf.statements) walk(statement, sf, options, out);
	return out;
}

function sourceLine(text: string, line: number): string {
	return (text.split("\n")[line - 1] ?? "").trim();
}

function describeEnd(text: string, token: Token | undefined): string {
	return token === undefined
		? "the end of the file"
		: `line ${token.line} \`${sourceLine(text, token.line)}\``;
}

export function compareExact(
	base: string,
	next: string,
	helpers: readonly string[],
): string[] {
	const named = new Set(helpers);
	const left = tokens("base.ts", base, { side: "base", helpers: named });
	const right = tokens("new.ts", next, { side: "new", helpers: named });
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (a?.text === b?.text) continue;
		return [
			`base ${describeEnd(base, a)} differs from new ${describeEnd(next, b)} (expected ${a?.text ?? "end of file"}, found ${b?.text ?? "end of file"})`,
		];
	}
	return [];
}

interface Assertion {
	readonly key: string;
	readonly line: number;
	readonly display: string;
}

function rootIdentifier(expression: ts.Expression): string | undefined {
	let current: ts.Expression = expression;
	for (;;) {
		if (ts.isIdentifier(current)) return current.text;
		if (
			ts.isCallExpression(current) ||
			ts.isPropertyAccessExpression(current) ||
			ts.isElementAccessExpression(current) ||
			ts.isNonNullExpression(current) ||
			ts.isParenthesizedExpression(current) ||
			ts.isAwaitExpression(current)
		)
			current = current.expression;
		else return undefined;
	}
}

function testCall(call: ts.CallExpression): string | undefined {
	const callee = call.expression;
	if (
		ts.isPropertyAccessExpression(callee) &&
		(callee.name.text === "each" || callee.name.text === "for")
	)
		return undefined;
	const root = rootIdentifier(callee);
	return root !== undefined && TEST_CALLS.has(root) && call.arguments.length > 0
		? root
		: undefined;
}

function assertions(name: string, text: string, side: Side): Assertion[] {
	const sf = parse(name, text);
	const found: Assertion[] = [];
	const render = (node: ts.Node): string => {
		const out: Token[] = [];
		walk(node, sf, { side }, out);
		return out.map((token) => token.text).join(" ");
	};
	const visit = (
		node: ts.Node,
		titles: readonly string[],
		inBody: boolean,
	): void => {
		if (ts.isCallExpression(node)) {
			const call = testCall(node);
			const [title, ...rest] = node.arguments;
			if (call !== undefined && title !== undefined) {
				const label = isStringish(title) ? title.text : render(title);
				const path = [...titles, `${call}(${label})`];
				found.push({
					key: `title\u0000${path.join(" > ")}`,
					line: lineOf(sf, node),
					display: `${call}(${JSON.stringify(label)})`,
				});
				visit(node.expression, titles, inBody);
				for (const argument of rest)
					visit(argument, path, inBody || BODY_CALLS.has(call));
				return;
			}
		}
		if (
			inBody &&
			ts.isExpressionStatement(node) &&
			rootIdentifier(node.expression) === "expect"
		) {
			found.push({
				key: `expect\u0000${titles.join(" > ")}\u0000${render(node.expression)}`,
				line: lineOf(sf, node),
				display: sourceLine(text, lineOf(sf, node)),
			});
			return;
		}
		ts.forEachChild(node, (child) => visit(child, titles, inBody));
	};
	visit(sf, [], false);
	return found;
}

export function compareAssertions(base: string, next: string): string[] {
	const left = assertions("base.ts", base, "base");
	const right = assertions("new.ts", next, "new");
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (a?.key === b?.key) continue;
		const where = (entry: Assertion | undefined): string =>
			entry === undefined
				? "nothing (the list ends)"
				: `line ${entry.line} \`${entry.display}\``;
		return [
			`assertion ${index + 1}: base has ${where(a)}, new has ${where(b)}`,
		];
	}
	return [];
}

export function gitBaseReader(
	root: string,
	ref: string = BASE_REF,
): (path: string) => string | undefined {
	return (path) => {
		const result = spawnSync("git", ["show", `${ref}:${path}`], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		return result.status === 0 ? result.stdout : undefined;
	};
}

export interface CheckMovedTestsOptions {
	readonly root: string;
	readonly outcome: string;
	readonly lane?: string | undefined;
	readonly readBase?: (path: string) => string | undefined;
}

export function checkMovedTests(
	options: CheckMovedTestsOptions,
): MovedTestResult[] {
	const rows = MOVED_TESTS.filter(
		(row) =>
			row.outcome === options.outcome &&
			(options.lane === undefined || row.lane === options.lane),
	);
	if (rows.length === 0)
		throw new Error(
			`no moved-test row for ${options.outcome}${options.lane === undefined ? "" : ` and lane ${options.lane}`}`,
		);
	const readBase = options.readBase ?? gitBaseReader(options.root);
	return rows.map((row) => {
		const absolute = join(options.root, row.next);
		if (!existsSync(absolute))
			return { ...row, differences: [`${row.next} does not exist`] };
		const base = readBase(row.base);
		if (base === undefined)
			return { ...row, differences: [`${row.base} is not at the base ref`] };
		const next = readFileSync(absolute, "utf8");
		const differences =
			row.mode === "exact"
				? compareExact(base, next, row.helpers === "any" ? [] : row.helpers)
				: compareAssertions(base, next);
		return { ...row, differences };
	});
}

function main(argv: readonly string[]): number {
	let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	let ref = BASE_REF;
	let lane: string | undefined;
	const positional: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--") continue;
		if (arg.startsWith("--root=")) root = resolve(arg.slice("--root=".length));
		else if (arg.startsWith("--base=")) ref = arg.slice("--base=".length);
		else if (arg.startsWith("--lane=")) lane = arg.slice("--lane=".length);
		else if (arg === "--lane") {
			lane = argv[index + 1];
			index += 1;
		} else positional.push(arg);
	}
	const [outcome] = positional;
	if (outcome === undefined || positional.length > 1 || lane === "") {
		process.stderr.write(
			"usage: fleet:moved-tests <outcome> [--lane <id>] [--root=<dir>] [--base=<ref>]\n",
		);
		return 2;
	}
	let results: MovedTestResult[];
	try {
		results = checkMovedTests({
			root,
			outcome,
			lane,
			readBase: gitBaseReader(root, ref),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`fleet:moved-tests: ${message}\n`);
		return 2;
	}
	const failed = results.filter((result) => result.differences.length > 0);
	for (const result of failed)
		for (const difference of result.differences)
			process.stderr.write(
				`${result.next} (base ${result.base}, ${result.mode}, ${result.lane}): ${difference}\n`,
			);
	if (failed.length > 0) {
		process.stderr.write(
			`fleet:moved-tests ${outcome}: ${failed.length} of ${results.length} file(s) differ beyond the moved-test rules\n`,
		);
		return 1;
	}
	process.stdout.write(
		`fleet:moved-tests ${outcome}: ${results.length} file(s) differ only as allowed\n`,
	);
	return 0;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	process.exit(main(process.argv.slice(2)));

#!/usr/bin/env node
/**
 * The HoBo CI error catalog: every `HOBO_CI_*` code a `hobo ci` command or the
 * relay returns, with its message and what to do, written to one page
 * (`docs/ci/errors.md`) from the source (ADR-0183).
 *
 * A code is read from the syntax tree, never from a list kept by hand:
 *
 * - the value of a `code:` property, with its sibling `message` (or `reason`)
 *   and `remediation`; both branches of a conditional (or of `??`) count;
 * - an argument of a call or `new` whose callee, declared in the same file,
 *   has a parameter named `code`; its `message` (or `reason`) and
 *   `remediation` parameters give the text;
 * - an entry of an exported table named `*_REFUSAL` or `*_CODES`
 *   (`RELAY_ADOPT_REFUSAL.notFound`), used anywhere.
 *
 * Any other `HOBO_CI_*` string, such as an environment variable's name, is
 * a setting and is left out. A message part computed at run time is shown as
 * `{name}`; a message built entirely at run time is left out and the page
 * says so.
 *
 * `--check` writes nothing and exits 1 when the committed page differs from
 * what the source produces. It loads only node builtins and `typescript`.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// public-contract: where the generated catalog page lives.
export const CATALOG_PATH = "docs/ci/errors.md";

const CODE = /^HOBO_CI_[A-Z0-9_]+$/u;
const TABLE_NAME = /_(REFUSAL|CODES)$/u;
const MESSAGE_KEYS = new Set(["message", "reason"]);
const REMEDIATION_KEY = "remediation";
const MAX_VARIANTS = 8;

export type CatalogEntry = Readonly<{
	code: string;
	/** Repository-relative files the code is returned from, sorted. */
	files: readonly string[];
	/** Each distinct message, in source order; empty when built at run time. */
	messages: readonly string[];
	/** Each distinct remediation, in source order. */
	remediations: readonly string[];
}>;

type Draft = { files: Set<string>; messages: string[]; remediations: string[] };

type Parsed = Readonly<{ path: string; file: ts.SourceFile }>;

/** Every `packages/<pkg>/src` TypeScript file that mentions `HOBO_CI_`, by repository-relative path. */
export function readSources(root: string): ReadonlyMap<string, string> {
	const sources = new Map<string, string>();
	const packages = join(root, "packages");
	if (!existsSync(packages)) return sources;
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith("_generated"))
				continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".d.ts")
			) {
				const text = readFileSync(path, "utf8");
				if (text.includes("HOBO_CI_"))
					sources.set(relative(root, path).split(sep).join("/"), text);
			}
		}
	};
	for (const name of readdirSync(packages).sort()) {
		const src = join(packages, name, "src");
		if (existsSync(src)) walk(src);
	}
	return sources;
}

function unwrap(node: ts.Expression): ts.Expression {
	let current = node;
	for (;;) {
		if (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isSatisfiesExpression(current) ||
			ts.isNonNullExpression(current)
		)
			current = current.expression;
		else return current;
	}
}

function propertyName(name: ts.PropertyName): string | undefined {
	return ts.isIdentifier(name) || ts.isStringLiteral(name)
		? name.text
		: undefined;
}

/** `Object.freeze({...})` or `{...}`, through `as const` and parentheses. */
function tableLiteral(
	node: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
	const inner = unwrap(node);
	if (ts.isObjectLiteralExpression(inner)) return inner;
	if (
		ts.isCallExpression(inner) &&
		inner.expression.getText() === "Object.freeze" &&
		inner.arguments[0] !== undefined
	)
		return tableLiteral(inner.arguments[0]);
	return undefined;
}

/** Code tables across every file: `TABLE.key` to its code, and the tables named as refusals. */
type CodeTables = Readonly<{
	/** `TABLE.key` to its code, spreads included. */
	codes: ReadonlyMap<string, string>;
	/** A refusal table's own codes, by the file it is declared in. */
	refusals: ReadonlyMap<string, ReadonlySet<string>>;
}>;

function readTables(files: readonly Parsed[]): CodeTables {
	const entries = new Map<string, Map<string, string>>();
	const spreads = new Map<string, string[]>();
	const homes = new Map<string, string>();
	for (const { path, file } of files) {
		const visit = (node: ts.Node): void => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer !== undefined
			) {
				const literal = tableLiteral(node.initializer);
				if (literal !== undefined) {
					const table = new Map<string, string>();
					const spread: string[] = [];
					for (const property of literal.properties) {
						if (ts.isPropertyAssignment(property)) {
							const key = propertyName(property.name);
							const value = unwrap(property.initializer);
							if (
								key !== undefined &&
								ts.isStringLiteralLike(value) &&
								CODE.test(value.text)
							)
								table.set(key, value.text);
						} else if (
							ts.isSpreadAssignment(property) &&
							ts.isIdentifier(property.expression)
						)
							spread.push(property.expression.text);
					}
					if (table.size > 0 || spread.length > 0) {
						entries.set(node.name.text, table);
						spreads.set(node.name.text, spread);
						homes.set(node.name.text, path);
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
	}
	const resolved = (name: string, seen: Set<string>): Map<string, string> => {
		const own = new Map(entries.get(name));
		if (seen.has(name)) return own;
		seen.add(name);
		for (const other of spreads.get(name) ?? [])
			for (const [key, code] of resolved(other, seen))
				if (!own.has(key)) own.set(key, code);
		return own;
	};
	const codes = new Map<string, string>();
	const refusals = new Map<string, Set<string>>();
	for (const name of entries.keys()) {
		const table = resolved(name, new Set());
		for (const [key, code] of table) codes.set(`${name}.${key}`, code);
		const home = homes.get(name);
		if (TABLE_NAME.test(name) && home !== undefined) {
			const own = refusals.get(home) ?? new Set<string>();
			for (const code of entries.get(name)?.values() ?? []) own.add(code);
			refusals.set(home, own);
		}
	}
	return { codes, refusals };
}

/** File-level `const NAME = "text"` bindings, to fill message placeholders. */
function constants(file: ts.SourceFile): ReadonlyMap<string, string> {
	const found = new Map<string, string>();
	for (const statement of file.statements)
		if (
			ts.isVariableStatement(statement) &&
			(statement.declarationList.flags & ts.NodeFlags.Const) !== 0
		)
			for (const declaration of statement.declarationList.declarations)
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.initializer !== undefined &&
					ts.isStringLiteralLike(unwrap(declaration.initializer))
				) {
					// SAFETY: `isStringLiteralLike` was checked on the same unwrapped node just above.
					const literal = unwrap(
						declaration.initializer,
					) as ts.StringLiteralLike;
					found.set(declaration.name.text, literal.text);
				}
	return found;
}

/** Callees in this file that take a `code` parameter, with each parameter's position. */
function helpers(file: ts.SourceFile): ReadonlyMap<string, readonly string[]> {
	const found = new Map<string, readonly string[]>();
	const names = (
		parameters: ts.NodeArray<ts.ParameterDeclaration>,
	): readonly string[] =>
		parameters.map((parameter) =>
			ts.isIdentifier(parameter.name) ? parameter.name.text : "",
		);
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name !== undefined)
			found.set(node.name.text, names(node.parameters));
		else if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			(ts.isArrowFunction(unwrap(node.initializer)) ||
				ts.isFunctionExpression(unwrap(node.initializer)))
		) {
			// SAFETY: the branch condition just checked the unwrapped initializer is a function.
			const fn = unwrap(node.initializer) as
				| ts.ArrowFunction
				| ts.FunctionExpression;
			found.set(node.name.text, names(fn.parameters));
		} else if (ts.isClassDeclaration(node) && node.name !== undefined) {
			const constructor = node.members.find(ts.isConstructorDeclaration);
			if (constructor !== undefined)
				found.set(node.name.text, names(constructor.parameters));
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	for (const [name, parameters] of found)
		if (!parameters.includes("code")) found.delete(name);
	return found;
}

/** The codes an expression in a code position can be. */
function codesOf(
	node: ts.Expression,
	tables: ReadonlyMap<string, string>,
): readonly string[] {
	const inner = unwrap(node);
	if (ts.isStringLiteralLike(inner))
		return CODE.test(inner.text) ? [inner.text] : [];
	if (ts.isConditionalExpression(inner))
		return [
			...codesOf(inner.whenTrue, tables),
			...codesOf(inner.whenFalse, tables),
		];
	if (
		ts.isBinaryExpression(inner) &&
		(inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
			inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)
	)
		return [...codesOf(inner.left, tables), ...codesOf(inner.right, tables)];
	if (ts.isPropertyAccessExpression(inner)) {
		const code = tables.get(inner.getText().replace(/\s+/gu, ""));
		return code === undefined ? [] : [code];
	}
	return [];
}

type Texts = ReadonlyMap<string, string>;

/** A placeholder for a part computed at run time. */
function placeholder(node: ts.Expression, texts: Texts): string {
	const inner = unwrap(node);
	if (ts.isIdentifier(inner)) return texts.get(inner.text) ?? `{${inner.text}}`;
	if (ts.isPropertyAccessExpression(inner) && !inner.getText().includes("("))
		return `{${inner.getText().replace(/\s+/gu, "")}}`;
	if (ts.isStringLiteralLike(inner)) return inner.text;
	return "{…}";
}

/** One rendering of a text expression, with placeholders for anything computed. */
function single(node: ts.Expression, texts: Texts): string | undefined {
	const variants = textsOf(node, texts);
	return variants?.length === 1 ? variants[0] : undefined;
}

/** Each text an expression can be, or undefined when it is built at run time. */
function textsOf(
	node: ts.Expression,
	texts: Texts,
): readonly string[] | undefined {
	const inner = unwrap(node);
	if (ts.isStringLiteralLike(inner)) return [inner.text];
	if (ts.isTemplateExpression(inner))
		return [
			inner.head.text +
				inner.templateSpans
					.map(
						(span) => placeholder(span.expression, texts) + span.literal.text,
					)
					.join(""),
		];
	if (ts.isIdentifier(inner)) {
		const known = texts.get(inner.text);
		return known === undefined ? undefined : [known];
	}
	if (ts.isConditionalExpression(inner)) {
		const left = textsOf(inner.whenTrue, texts);
		const right = textsOf(inner.whenFalse, texts);
		if (left === undefined || right === undefined) return undefined;
		const both = [...left, ...right];
		return both.length > MAX_VARIANTS ? undefined : both;
	}
	if (
		ts.isBinaryExpression(inner) &&
		inner.operatorToken.kind === ts.SyntaxKind.PlusToken
	) {
		const left = single(inner.left, texts) ?? placeholder(inner.left, texts);
		const right = single(inner.right, texts) ?? placeholder(inner.right, texts);
		return [left + right];
	}
	if (
		ts.isCallExpression(inner) &&
		ts.isPropertyAccessExpression(inner.expression) &&
		inner.expression.name.text === "join" &&
		ts.isArrayLiteralExpression(unwrap(inner.expression.expression))
	) {
		// SAFETY: the branch condition just checked the unwrapped receiver is an array literal.
		const array = unwrap(
			inner.expression.expression,
		) as ts.ArrayLiteralExpression;
		const separator = inner.arguments[0];
		const joiner =
			separator === undefined
				? ","
				: ts.isStringLiteralLike(separator)
					? separator.text
					: undefined;
		if (joiner === undefined) return undefined;
		return [
			array.elements
				.map((element) =>
					ts.isSpreadElement(element)
						? "{…}"
						: (single(element, texts) ?? placeholder(element, texts)),
				)
				.join(joiner),
		];
	}
	return undefined;
}

/** Remediation lines: a string, or an array of strings. */
function remediationsOf(node: ts.Expression, texts: Texts): readonly string[] {
	const inner = unwrap(node);
	if (ts.isArrayLiteralExpression(inner))
		return inner.elements.flatMap((element) =>
			ts.isSpreadElement(element) ? [] : (textsOf(element, texts) ?? []),
		);
	return textsOf(inner, texts) ?? [];
}

function record(
	drafts: Map<string, Draft>,
	codes: readonly string[],
	path: string,
	messages: readonly string[],
	remediations: readonly string[],
): void {
	for (const code of codes) {
		const draft = drafts.get(code) ?? {
			files: new Set<string>(),
			messages: [],
			remediations: [],
		};
		draft.files.add(path);
		for (const message of messages)
			if (!draft.messages.includes(message)) draft.messages.push(message);
		for (const remediation of remediations)
			if (!draft.remediations.includes(remediation))
				draft.remediations.push(remediation);
		drafts.set(code, draft);
	}
}

/** Every `HOBO_CI_*` code in `sources` (repository-relative path to text), sorted by code. */
export function collectCodes(
	sources: ReadonlyMap<string, string>,
): CatalogEntry[] {
	const files: Parsed[] = [...sources.keys()].sort().map((path) => ({
		path,
		file: ts.createSourceFile(
			path,
			sources.get(path) ?? "",
			ts.ScriptTarget.ES2022,
			true,
			ts.ScriptKind.TS,
		),
	}));
	const tables = readTables(files);
	const drafts = new Map<string, Draft>();
	for (const [path, codes] of tables.refusals)
		record(drafts, [...codes], path, [], []);
	for (const { path, file } of files) {
		const texts = constants(file);
		const callees = helpers(file);
		const visit = (node: ts.Node): void => {
			if (ts.isObjectLiteralExpression(node)) {
				const properties = new Map<string, ts.Expression>();
				for (const property of node.properties)
					if (ts.isPropertyAssignment(property)) {
						const key = propertyName(property.name);
						if (key !== undefined) properties.set(key, property.initializer);
					}
				const code = properties.get("code");
				if (code !== undefined) {
					const message = [...MESSAGE_KEYS]
						.map((key) => properties.get(key))
						.find((value) => value !== undefined);
					const remediation = properties.get(REMEDIATION_KEY);
					record(
						drafts,
						codesOf(code, tables.codes),
						path,
						message === undefined ? [] : (textsOf(message, texts) ?? []),
						remediation === undefined ? [] : remediationsOf(remediation, texts),
					);
				}
			} else if (
				(ts.isCallExpression(node) || ts.isNewExpression(node)) &&
				ts.isIdentifier(node.expression)
			) {
				const parameters = callees.get(node.expression.text);
				const args = node.arguments ?? [];
				if (parameters !== undefined) {
					const at = (
						names: ReadonlySet<string>,
					): ts.Expression | undefined => {
						const index = parameters.findIndex((name) => names.has(name));
						return index < 0 ? undefined : args[index];
					};
					const code = at(new Set(["code"]));
					const message = at(MESSAGE_KEYS);
					const remediation = at(new Set([REMEDIATION_KEY]));
					if (code !== undefined)
						record(
							drafts,
							codesOf(code, tables.codes),
							path,
							message === undefined ? [] : (textsOf(message, texts) ?? []),
							remediation === undefined
								? []
								: remediationsOf(remediation, texts),
						);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
	}
	return [...drafts.keys()].sort().map((code) => {
		const draft = drafts.get(code) ?? {
			files: new Set<string>(),
			messages: [],
			remediations: [],
		};
		return {
			code,
			files: [...draft.files].sort(),
			messages: draft.messages,
			remediations: draft.remediations,
		};
	});
}

/** Markdown-safe inline text: no raw HTML, no line breaks. */
function inline(text: string): string {
	return text.replace(/\s*\n\s*/gu, " ").replace(/</gu, "\\<");
}

/** The catalog page for `entries`. */
export function renderCatalog(entries: readonly CatalogEntry[]): string {
	const sorted = [...entries].sort((a, b) =>
		a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
	);
	const lines = [
		"---",
		"type: CI Reference",
		'title: "HoBo CI error catalog"',
		'description: "Every HOBO_CI_* code a hobo ci command or the relay returns, with its message and what to do. Generated from source by scripts/ci/error-catalog.mts."',
		"tags: [hobo, ci, relay, errors, reference]",
		"---",
		"",
		"<!-- Generated by scripts/ci/error-catalog.mts. Do not edit: run `node --import tsx scripts/ci/error-catalog.mts`. -->",
		"",
		"# HoBo CI error catalog",
		"",
		"A `hobo ci` command that stops prints a code with its message; with `--json` the code is the",
		"`code` field. Codes are stable: a code's meaning does not change, and a new failure gets a new",
		"code. A few codes report an outcome rather than a failure, and their message says so. The",
		"runner order these codes guard is described in",
		"[ADR-0183](../design/adr/runner-order.md#adr-0183).",
		"",
		"This page is generated from the source, so it lists every code the code returns and nothing",
		"else. Text in braces, such as `{repository}`, is filled in when the command runs. A code whose",
		"message is composed when the command runs shows no message here; read the command's output.",
		"",
		"Agents reach this page through the `hobo-ci` skill (`.claude/skills/hobo-ci/`, mirrored in",
		"`.agents/skills/`), beside `hobo-ci-route-jobs` and `hobo-ci-insights`. The one-page setup guide",
		"for an agent starting from nothing is [`site/public/ci/setup.md`](../../site/public/ci/setup.md).",
		"",
		`${sorted.length} codes.`,
		"",
		"| Code | Returned from |",
		"| --- | --- |",
		...sorted.map(
			(entry) =>
				`| [\`${entry.code}\`](#${entry.code.toLowerCase()}) | ${entry.files.map((file) => `\`${file}\``).join(", ")} |`,
		),
		"",
		"## Codes",
	];
	for (const entry of sorted) {
		lines.push("", `### ${entry.code}`, "");
		lines.push(
			`Returned from ${entry.files.map((file) => `\`${file}\``).join(", ")}.`,
			"",
		);
		if (entry.messages.length === 0)
			lines.push("Message: composed when the command runs.");
		else {
			lines.push(entry.messages.length === 1 ? "Message:" : "Messages:");
			for (const message of entry.messages)
				lines.push("", "```text", message.replace(/\n+$/u, ""), "```");
		}
		lines.push("");
		if (entry.remediations.length === 0)
			lines.push("What to do: follow the message.");
		else {
			lines.push("What to do:", "");
			for (const remediation of entry.remediations)
				lines.push(`- ${inline(remediation)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

type Output = Readonly<{
	log: (line: string) => void;
	error: (line: string) => void;
}>;

/** Writes the page, or with `--check` compares it; returns the exit status. */
export function main(
	argv: readonly string[],
	root: string,
	output: Output = console,
): number {
	const check = argv.includes("--check");
	const page = renderCatalog(collectCodes(readSources(root)));
	const target = join(root, CATALOG_PATH);
	const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
	if (check) {
		if (current === page) {
			output.log(`${CATALOG_PATH} is up to date.`);
			return 0;
		}
		output.error(
			`${CATALOG_PATH} is stale. Run: node --import tsx scripts/ci/error-catalog.mts`,
		);
		return 1;
	}
	if (current !== page) {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, page);
	}
	output.log(`Wrote ${CATALOG_PATH}.`);
	return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
	process.exit(
		main(process.argv.slice(2), resolve(import.meta.dirname, "../..")),
	);

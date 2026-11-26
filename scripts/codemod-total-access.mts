/**
 * Codemod: replace `expr!` (non-null assertion) with a total accessor that
 * fails loudly and names what was missing.
 *
 * eli5: `xs[0]!` tells the type checker "trust me". When the trust is
 * misplaced, `undefined` leaks downstream and blows up somewhere unrelated.
 * `first(xs, "xs")` narrows the same way but throws *here*, saying what was
 * missing — see `@hobo/core/total-access`.
 *
 * Usage:
 *   node --import tsx scripts/codemod-total-access.mts <file-or-dir>...
 *   node --import tsx scripts/codemod-total-access.mts --dry <paths>
 *
 * The rewrite is textual but driven by the TypeScript AST, so it never guesses
 * where an expression begins. Sites it cannot rewrite safely are reported and
 * left alone for a human.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";

type Rewrite = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly helper: HelperName;
};

type HelperName = "must" | "at" | "first" | "last" | "get";

const DRY = process.argv.includes("--dry");
const TARGETS = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

/** Source text of a node, collapsed to a single line for use as a label. */
function label(node: ts.Node, source: ts.SourceFile): string {
	return node
		.getText(source)
		.replace(/\s+/gu, " ")
		.replace(/"/gu, "'")
		.slice(0, 80);
}

/**
 * Choose the helper that best expresses this assertion.
 *
 * `xs[0]!` → first(xs, "xs"); `xs[i]!` → at(xs, i, "xs");
 * `m.get(k)!` → get(m, k, "m"); anything else → must(expr, "expr").
 */
function planRewrite(
	node: ts.NonNullExpression,
	source: ts.SourceFile,
): Rewrite | null {
	const inner = node.expression;

	if (ts.isElementAccessExpression(inner)) {
		const target = inner.expression.getText(source);
		const index = inner.argumentExpression;
		// `at`/`first` are array accessors. Without a type checker the only
		// index we can *prove* is an array index is a numeric literal — a
		// variable key may well be a record lookup, so that falls through to
		// `must`, which is correct for both shapes.
		// A negative literal is NOT an array index: `xs[-1]` is always undefined,
		// whereas `at(xs, -1)` returns the last element. Routing it through `at`
		// would turn a latent bug into working code and hide it. Send it to
		// `must`, which preserves the original meaning exactly.
		const negative =
			ts.isPrefixUnaryExpression(index) &&
			index.operator === ts.SyntaxKind.MinusToken;
		if (ts.isNumericLiteral(index) && !negative) {
			const indexText = index.getText(source);
			if (indexText === "0") {
				return {
					start: node.getStart(source),
					end: node.getEnd(),
					text: `first(${target}, "${label(inner.expression, source)}")`,
					helper: "first",
				};
			}
			return {
				start: node.getStart(source),
				end: node.getEnd(),
				text: `at(${target}, ${indexText}, "${label(inner.expression, source)}")`,
				helper: "at",
			};
		}
		return {
			start: node.getStart(source),
			end: node.getEnd(),
			text: `must(${inner.getText(source)}, "${label(inner, source)}")`,
			helper: "must",
		};
	}

	if (
		ts.isCallExpression(inner) &&
		ts.isPropertyAccessExpression(inner.expression) &&
		inner.arguments.length === 1
	) {
		const method = inner.expression.name.text;
		const receiver = inner.expression.expression;
		const receiverText = receiver.getText(source);
		const argText = inner.arguments[0]?.getText(source) ?? "";
		if (method === "get") {
			return {
				start: node.getStart(source),
				end: node.getEnd(),
				text: `get(${receiverText}, ${argText}, "${label(receiver, source)}")`,
				helper: "get",
			};
		}
		if (method === "at" && argText === "-1") {
			return {
				start: node.getStart(source),
				end: node.getEnd(),
				text: `last(${receiverText}, "${label(receiver, source)}")`,
				helper: "last",
			};
		}
	}

	if (
		ts.isCallExpression(inner) &&
		ts.isPropertyAccessExpression(inner.expression) &&
		inner.arguments.length === 0
	) {
		const method = inner.expression.name.text;
		if (method === "pop" || method === "shift") {
			// `q.shift()!` mutates — keep the call, just make the emptiness loud.
			return {
				start: node.getStart(source),
				end: node.getEnd(),
				text: `must(${inner.getText(source)}, "${label(inner, source)}")`,
				helper: "must",
			};
		}
	}

	// A bare `foo!` used as a *call target* or in a `new` position would change
	// meaning if wrapped; those are left for a human.
	const parent = node.parent;
	if (
		(ts.isCallExpression(parent) && parent.expression === node) ||
		(ts.isNewExpression(parent) && parent.expression === node) ||
		ts.isTaggedTemplateExpression(parent)
	) {
		return null;
	}

	return {
		start: node.getStart(source),
		end: node.getEnd(),
		text: `must(${inner.getText(source)}, "${label(inner, source)}")`,
		helper: "must",
	};
}

function collect(node: ts.Node, out: ts.NonNullExpression[]): void {
	if (ts.isNonNullExpression(node)) out.push(node);
	ts.forEachChild(node, (child) => collect(child, out));
}

/** Import specifier for `@hobo/core/total-access` from a file inside core itself. */
function importSpecifier(file: string): string {
	const parts = file.split(sep);
	const packagesAt = parts.lastIndexOf("packages");
	if (packagesAt >= 0 && parts[packagesAt + 1] === "core") {
		const fromDir = join(...parts.slice(0, -1));
		const target = join(
			...parts.slice(0, packagesAt + 2),
			"src",
			"total-access.ts",
		);
		let rel = relative(fromDir, target).replace(/\.ts$/u, ".js");
		if (!rel.startsWith(".")) rel = `./${rel}`;
		return rel;
	}
	return "@hobo/core/total-access";
}

type RewriteCount = {
	changed: number;
	skipped: number;
};

function rewriteFile(file: string): RewriteCount {
	const text = readFileSync(file, "utf8");
	if (!text.includes("!")) return { changed: 0, skipped: 0 };
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
	const nodes: ts.NonNullExpression[] = [];
	collect(source, nodes);
	if (nodes.length === 0) return { changed: 0, skipped: 0 };

	const rewrites: Rewrite[] = [];
	let skipped = 0;
	for (const node of nodes) {
		const plan = planRewrite(node, source);
		if (plan === null) {
			skipped += 1;
			console.warn(
				`  skip ${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} — ${label(node, source)}`,
			);
			continue;
		}
		rewrites.push(plan);
	}
	if (rewrites.length === 0) return { changed: 0, skipped };

	// Apply back-to-front so earlier offsets stay valid. Nested assertions are
	// rewritten outermost-first; the inner text is carried along verbatim.
	const ordered = [...rewrites].sort((a, b) => b.start - a.start);
	const helpers = new Set<HelperName>(ordered.map((r) => r.helper));
	const names = [...helpers].sort();

	// A helper name may already be bound in this file (`const first = …`).
	// Rather than reason about scopes, fall back to a namespace import whenever
	// the name appears as a binding anywhere — always correct, never shadowed.
	// The prefix is applied to the replacement text we generate, NEVER by a
	// blanket regex over the file: a local `function first()` that is *called*
	// would otherwise have its own calls rewritten to point at the helper.
	const collides = names.some((n) =>
		new RegExp(`\\b(?:const|let|var|function|class)\\s+${n}\\b`, "u").test(
			text,
		),
	);
	const qualify = (r: Rewrite): string =>
		collides ? r.text.replace(r.helper, `totalAccess.${r.helper}`) : r.text;

	let out = text;
	let applied = 0;
	let lastStart = Number.POSITIVE_INFINITY;
	for (const r of ordered) {
		if (r.end > lastStart) continue; // nested inside a rewrite already applied
		out = `${out.slice(0, r.start)}${qualify(r)}${out.slice(r.end)}`;
		lastStart = r.start;
		applied += 1;
	}

	// Re-running over an already-converted file must not add a second import:
	// biome merges the two lines and leaves `import { must, must }`, a parse
	// error. Merge into the existing one instead.
	const existing = new RegExp(
		`import \\{([^}]*)\\} from "${importSpecifier(file).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}";`,
		"u",
	).exec(out);
	if (existing && !collides) {
		const merged = [
			...new Set([
				...(existing[1] ?? "")
					.split(",")
					.map((n) => n.trim())
					.filter(Boolean),
				...names,
			]),
		].sort();
		out = out.replace(
			existing[0],
			`import { ${merged.join(", ")} } from "${importSpecifier(file)}";`,
		);
		if (!DRY) writeFileSync(file, out);
		return { changed: applied, skipped };
	}

	const importLine = collides
		? `import * as totalAccess from "${importSpecifier(file)}";`
		: `import { ${names.join(", ")} } from "${importSpecifier(file)}";`;
	const lines = out.split("\n");
	let insertAt = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.startsWith("import ") || line.startsWith("} from "))
			insertAt = i + 1;
	}
	lines.splice(insertAt, 0, importLine);
	out = lines.join("\n");

	if (!DRY) writeFileSync(file, out);
	return { changed: applied, skipped };
}

function walk(path: string, out: string[]): void {
	const st = statSync(path);
	if (st.isDirectory()) {
		if (/node_modules|dist|_generated|\.turbo/u.test(path)) return;
		for (const entry of readdirSync(path)) walk(join(path, entry), out);
		return;
	}
	if (/\.(ts|mts)$/u.test(path) && !path.endsWith(".d.ts")) out.push(path);
}

const files: string[] = [];
for (const target of TARGETS) walk(target, files);

let totalChanged = 0;
let totalSkipped = 0;
let touched = 0;
for (const file of files) {
	const { changed, skipped } = rewriteFile(file);
	if (changed > 0) touched += 1;
	totalChanged += changed;
	totalSkipped += skipped;
}
console.log(
	`${DRY ? "[dry] " : ""}rewrote ${totalChanged} assertions in ${touched} files; ${totalSkipped} left for review`,
);


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

function label(node: ts.Node, source: ts.SourceFile): string {
	return node
		.getText(source)
		.replace(/\s+/gu, " ")
		.replace(/"/gu, "'")
		.slice(0, 80);
}

function planRewrite(
	node: ts.NonNullExpression,
	source: ts.SourceFile,
): Rewrite | null {
	const inner = node.expression;

	if (ts.isElementAccessExpression(inner)) {
		const target = inner.expression.getText(source);
		const index = inner.argumentExpression;
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
			return {
				start: node.getStart(source),
				end: node.getEnd(),
				text: `must(${inner.getText(source)}, "${label(inner, source)}")`,
				helper: "must",
			};
		}
	}

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

	const ordered = [...rewrites].sort((a, b) => b.start - a.start);
	const helpers = new Set<HelperName>(ordered.map((r) => r.helper));
	const names = [...helpers].sort();

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
		if (r.end > lastStart) continue;
		out = `${out.slice(0, r.start)}${qualify(r)}${out.slice(r.end)}`;
		lastStart = r.start;
		applied += 1;
	}

	// biome merges the two lines and leaves `import { must, must }`, a parse
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

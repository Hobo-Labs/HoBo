import ts from "typescript";

const generatedDirective = /^\/\/\s*@generated\b/u;
const toolDirective =
	/^\/\*\s*(?:eslint-(?:disable|enable)|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|@(?:license|preserve|vite-ignore)\b|SPDX-License-Identifier:|copyright\b)/iu;
const lineDirective =
	/^\/\/\s*(?:@ts-(?:check|nocheck|ignore|expect-error)\b|[#@]\s*sourceMappingURL=|SPDX-License-Identifier:|copyright\b)/iu;
const licenseDirective =
	/^\s*\*\s*(?:@license\b|SPDX-License-Identifier:|copyright\b)/imu;
const deprecatedTag = /^\s*\*\s*@deprecated\b/mu;
const inlineDeprecatedTag = /^\/\*\*\s*@deprecated\b/u;

export function conciseGeneratedTypeScript(source: string): string {
	const parsed = ts.createSourceFile(
		"generated.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const comments = new Map<number, ts.CommentRange>();
	function visit(node: ts.Node): void {
		for (const position of [node.getFullStart(), node.getEnd()]) {
			for (const range of [
				...(ts.getLeadingCommentRanges(source, position) ?? []),
				...(ts.getTrailingCommentRanges(source, position) ?? []),
			])
				comments.set(range.pos, range);
		}
		for (const child of node.getChildren(parsed)) visit(child);
	}
	visit(parsed);
	const edits: Array<{ start: number; end: number; replacement: string }> = [];
	for (const { pos: start, end } of [...comments.values()].sort(
		(a, b) => a.pos - b.pos,
	)) {
		const comment = source.slice(start, end);
		if (
			generatedDirective.test(comment) ||
			toolDirective.test(comment) ||
			lineDirective.test(comment) ||
			licenseDirective.test(comment)
		) {
			continue;
		}
		if (deprecatedTag.test(comment) || inlineDeprecatedTag.test(comment)) {
			edits.push({ start, end, replacement: "/** @deprecated */" });
		} else {
			const lineStart = source.lastIndexOf("\n", start - 1) + 1;
			const nextLine = source.indexOf("\n", end);
			const lineEnd = nextLine === -1 ? source.length : nextLine;
			const standalone =
				source.slice(lineStart, start).trim() === "" &&
				source.slice(end, lineEnd).trim() === "";
			edits.push(
				standalone
					? {
							start: lineStart,
							end: nextLine === -1 ? lineEnd : lineEnd + 1,
							replacement: "",
						}
					: { start, end, replacement: " " },
			);
		}
	}
	let result = source;
	for (const edit of edits.reverse()) {
		result =
			result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
	}
	const printer = ts.createPrinter({ removeComments: true });
	const resultFile = ts.createSourceFile(
		"generated.ts",
		result,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	if (printer.printFile(parsed) !== printer.printFile(resultFile)) {
		throw new Error(
			"removing generated comments would change TypeScript syntax",
		);
	}
	return result;
}

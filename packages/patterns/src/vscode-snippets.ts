import { createHash } from "node:crypto";

import { type PatternCatalog, readRenderingBody } from "./catalog.js";

export type VsCodeSnippetBuildReceipt = {
	readonly count: number;
	readonly digest: string;
	readonly snippets: Readonly<
		Record<
			string,
			{
				readonly prefix: string;
				readonly body: readonly string[];
				readonly description: string;
			}
		>
	>;
	readonly llmCalls: 0;
};

export function buildVsCodeSnippets(input: {
	readonly catalog: PatternCatalog;
}): VsCodeSnippetBuildReceipt {
	const snippets: Record<
		string,
		{ prefix: string; body: string[]; description: string }
	> = {};
	for (const pattern of input.catalog.patterns) {
		const snippet =
			pattern.renderings.find((item) => item.renderingId.includes("snippet")) ??
			pattern.renderings[0];
		if (!snippet) continue;
		snippets[pattern.id] = {
			prefix: pattern.id,
			body: readRenderingBody(
				input.catalog,
				pattern,
				snippet.renderingId,
			).split("\n"),
			description: pattern.intent,
		};
	}
	const serialized = `${JSON.stringify(snippets, Object.keys(snippets).sort(), "\t")}\n`;
	return {
		count: Object.keys(snippets).length,
		digest: createHash("sha256").update(serialized).digest("hex"),
		snippets,
		llmCalls: 0,
	};
}

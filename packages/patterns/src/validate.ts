import { create } from "@bufbuild/protobuf";
import * as ts from "typescript";

import {
	type PatternEvalCase,
	PatternEvalCaseSchema,
	type PatternEvalReport,
	PatternEvalReportSchema,
	type PatternManifest,
	type PatternRenderReceipt,
} from "./_generated/patterns_pb.js";
import type { PatternCatalog } from "./catalog.js";
import { PatternParseError } from "./parse.js";
import { searchPatterns } from "./retrieve.js";
import type { HoboVocabulary } from "./vocabulary.js";

export type PatternCatalogValidationReport = {
	readonly ok: boolean;
	readonly issues: readonly string[];
	readonly patternCount: number;
	readonly digest: string;
};

export type PatternOutputValidationReport = {
	readonly ok: boolean;
	readonly issues: readonly string[];
	readonly digest: string;
};

export function validatePatternCatalog(input: {
	readonly catalog: PatternCatalog;
}): PatternCatalogValidationReport {
	const issues: string[] = [];
	const ids = new Set<string>();
	const exactAliases = new Map<string, string>();
	for (const pattern of input.catalog.patterns) {
		if (ids.has(pattern.id)) issues.push(`duplicate id ${pattern.id}`);
		ids.add(pattern.id);
		if (pattern.version <= 0) issues.push(`${pattern.id}: version`);
		if (pattern.provenance.length === 0)
			issues.push(`${pattern.id}: provenance`);
		const defaults = pattern.renderings.filter((item) => item.isDefault);
		if (defaults.length !== 1) issues.push(`${pattern.id}: default rendering`);
		for (const alias of [...pattern.aliases, ...pattern.legacyAliases]) {
			const key = alias.trim().toLowerCase();
			if (!key) continue;
			const prior = exactAliases.get(key);
			if (prior && prior !== pattern.id) {
				issues.push(`alias ${alias} claimed by ${prior} and ${pattern.id}`);
			}
			exactAliases.set(key, pattern.id);
		}
		const provide = new Set(pattern.provides);
		for (const conflict of pattern.conflicts) {
			if (provide.has(conflict)) {
				issues.push(`${pattern.id}: provides and conflicts ${conflict}`);
			}
		}
	}
	return {
		ok: issues.length === 0,
		issues,
		patternCount: input.catalog.patterns.length,
		digest: input.catalog.digest,
	};
}

export function validateRenderedPattern(input: {
	readonly pattern: PatternManifest;
	readonly rendered: PatternRenderReceipt;
}): PatternOutputValidationReport {
	const issues: string[] = [];
	if (input.rendered.patternId !== input.pattern.id) {
		issues.push("pattern id mismatch");
	}
	if (input.rendered.llmCalls !== 0) issues.push("llmCalls must be 0");
	for (const file of input.rendered.files) {
		if (file.path.startsWith("/") || file.path.includes("..")) {
			issues.push(`unsafe path ${file.path}`);
		}
		if (file.path.endsWith(".ts") || file.path.endsWith(".tsx")) {
			const result = ts.transpileModule(file.contents, {
				compilerOptions: {
					target: ts.ScriptTarget.Latest,
					module: ts.ModuleKind.ESNext,
				},
				fileName: file.path,
				reportDiagnostics: true,
			});
			const first = result.diagnostics?.find(
				(item) => item.category === ts.DiagnosticCategory.Error,
			);
			if (first) {
				issues.push(
					`${file.path}: ${ts.flattenDiagnosticMessageText(first.messageText, "\n")}`,
				);
			}
			if (
				input.pattern.id.startsWith("bindle.") &&
				!input.pattern.id.includes("guidance") &&
				!file.contents.includes("bindle(") &&
				!file.contents.includes("b.api") &&
				!file.contents.includes("b.web") &&
				!file.contents.includes("b.kv") &&
				!file.contents.includes("b.queue")
			) {
				issues.push(`${file.path}: missing Bindle authoring surface`);
			}
			if (
				file.contents.includes("aws-") ||
				file.contents.includes("provider:") ||
				/sk-[A-Za-z0-9]{16,}/u.test(file.contents)
			) {
				issues.push(`${file.path}: prohibited provider pin or secret`);
			}
		}
	}
	return {
		ok: issues.length === 0,
		issues,
		digest: input.rendered.replayDigest,
	};
}

export function evaluatePatternRetrieval(input: {
	readonly catalog: PatternCatalog;
	readonly vocabulary: HoboVocabulary;
	readonly cases: readonly PatternEvalCase[];
}): PatternEvalReport {
	const started = Date.now();
	let hit1 = 0;
	let hit3 = 0;
	let abstainOk = 0;
	let abstainN = 0;
	let scored = 0;
	for (const testCase of input.cases) {
		const receipt = searchPatterns({
			catalog: input.catalog,
			vocabulary: input.vocabulary,
			query: testCase.query,
		});
		if (testCase.expectAbstain) {
			abstainN += 1;
			if (receipt.selectedId === "") abstainOk += 1;
			continue;
		}
		scored += 1;
		const ids = receipt.candidates.map((item) => item.patternId);
		if (testCase.expectedIds[0] && ids[0] === testCase.expectedIds[0])
			hit1 += 1;
		if (testCase.expectedIds.some((id) => ids.slice(0, 3).includes(id)))
			hit3 += 1;
	}
	return create(PatternEvalReportSchema, {
		cases: input.cases.length,
		recallAt1: scored === 0 ? 0 : hit1 / scored,
		recallAt3: scored === 0 ? 0 : hit3 / scored,
		abstainPrecision: abstainN === 0 ? 1 : abstainOk / abstainN,
		elapsedMs: Date.now() - started,
	});
}

export function parseEvalCases(raw: string): PatternEvalCase[] {
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const rec = JSON.parse(line) as {
				id?: unknown;
				query?: unknown;
				expectedIds?: unknown;
				expectAbstain?: unknown;
			};
			if (typeof rec.id !== "string" || typeof rec.query !== "string") {
				throw new PatternParseError("eval case needs id and query");
			}
			return create(PatternEvalCaseSchema, {
				id: rec.id,
				query: rec.query,
				expectedIds: Array.isArray(rec.expectedIds)
					? rec.expectedIds.filter(
							(item): item is string => typeof item === "string",
						)
					: [],
				expectAbstain: rec.expectAbstain === true,
			});
		});
}

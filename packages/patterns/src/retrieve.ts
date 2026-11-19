import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";

import {
	type PatternManifest,
	type PatternSearchReceipt,
	PatternSearchReceiptSchema,
	ReceiptStatus,
	SearchChannel,
	SearchDecision,
} from "./_generated/patterns_pb.js";
import type { PatternCatalog } from "./catalog.js";
import {
	cosineSimilarity,
	decodeVectorBlob,
	encodeOntologyVector,
	encodePatternDocument,
} from "./encode.js";
import { parsePatternQuery } from "./parse.js";
import {
	loadIndexVectors,
	type PatternIndex,
	searchIndexLexical,
} from "./sqlite-index.js";
import { type HoboVocabulary, normalizePatternQuery } from "./vocabulary.js";

const RRF_K = 60;
const SELECT_SCORE = 0.35;
const SELECT_MARGIN = 0.08;

function rrf(ranks: readonly number[]): number {
	return ranks.reduce((sum, rank) => sum + 1 / (RRF_K + rank), 0);
}

function compileFts(terms: readonly string[]): string {
	return terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" ");
}

export function searchPatterns(input: {
	readonly catalog: PatternCatalog;
	readonly vocabulary: HoboVocabulary;
	readonly query: unknown;
	readonly ftsAvailable?: boolean;
	readonly index?: PatternIndex;
}): PatternSearchReceipt {
	const started = Date.now();
	const request = parsePatternQuery(input.query);
	const normalized = normalizePatternQuery(
		request.query || request.exactId,
		input.vocabulary,
	);
	const queryVector = encodeOntologyVector(
		normalized.features,
		input.vocabulary,
	);
	const indexVectors = input.index
		? new Map(
				loadIndexVectors(input.index).map((row) => [
					row.patternId,
					cosineSimilarity(
						queryVector,
						decodeVectorBlob(
							row.blob,
							row.dimensions,
							input.vocabulary.encoderId,
						),
					),
				]),
			)
		: undefined;
	const indexLex = input.index
		? new Map(
				searchIndexLexical(input.index, normalized.terms).map((row) => [
					row.patternId,
					row,
				]),
			)
		: undefined;
	const ftsAvailable = input.index
		? input.index.ftsAvailable
		: input.ftsAvailable !== false;

	const filtered = input.catalog.patterns.filter((pattern) => {
		if (
			request.kindFilter.length > 0 &&
			!request.kindFilter.includes(pattern.kind)
		) {
			return false;
		}
		if (
			request.maturityFilter.length > 0 &&
			!request.maturityFilter.includes(pattern.maturity)
		) {
			return false;
		}
		if (
			request.languageFilter &&
			!pattern.languages.includes(request.languageFilter)
		) {
			return false;
		}
		if (
			request.contextFilter &&
			!pattern.contexts.includes(request.contextFilter)
		) {
			return false;
		}
		return true;
	});

	const ranked = filtered.map((pattern) => {
		const exactId =
			request.exactId === pattern.id || request.query === pattern.id;
		const exactAlias = pattern.aliases.some(
			(alias) => alias === request.query || alias === request.exactId,
		);
		const exactSymbol = pattern.apiSymbols.some((symbol) =>
			(request.query || "").includes(symbol),
		);
		const hay =
			`${pattern.id} ${pattern.title} ${pattern.intent} ${pattern.description} ${pattern.aliases.join(" ")}`.toLowerCase();
		const lexical =
			indexLex?.get(pattern.id)?.score ??
			normalized.terms.filter((term) => hay.includes(term)).length;
		const vector =
			indexVectors?.get(pattern.id) ??
			cosineSimilarity(
				queryVector,
				encodePatternDocument(pattern, input.vocabulary),
			);
		return { pattern, exactId, exactAlias, exactSymbol, lexical, vector };
	});

	const byExact = [...ranked]
		.filter((row) => row.exactId || row.exactAlias)
		.sort((a, b) => a.pattern.id.localeCompare(b.pattern.id));
	const bySymbol = [...ranked]
		.filter((row) => row.exactSymbol)
		.sort((a, b) => a.pattern.id.localeCompare(b.pattern.id));
	const byLex = [...ranked]
		.filter((row) => row.lexical > 0)
		.sort(
			(a, b) =>
				b.lexical - a.lexical || a.pattern.id.localeCompare(b.pattern.id),
		);
	const byVec = [...ranked].sort(
		(a, b) => b.vector - a.vector || a.pattern.id.localeCompare(b.pattern.id),
	);

	const fused = ranked
		.map((row) => {
			const ranks: number[] = [];
			const channels = [];
			const exactRank = byExact.findIndex(
				(item) => item.pattern.id === row.pattern.id,
			);
			if (exactRank >= 0) {
				ranks.push(exactRank + 1);
				channels.push({
					channel: row.exactId
						? SearchChannel.EXACT_ID
						: SearchChannel.EXACT_ALIAS,
					rank: exactRank + 1,
					score: 1,
				});
			}
			const symbolRank = bySymbol.findIndex(
				(item) => item.pattern.id === row.pattern.id,
			);
			if (symbolRank >= 0) {
				ranks.push(symbolRank + 1);
				channels.push({
					channel: SearchChannel.EXACT_SYMBOL,
					rank: symbolRank + 1,
					score: 1,
				});
			}
			if (ftsAvailable) {
				const lexRank = byLex.findIndex(
					(item) => item.pattern.id === row.pattern.id,
				);
				if (lexRank >= 0) {
					ranks.push(lexRank + 1);
					channels.push({
						channel: SearchChannel.FTS5,
						rank: lexRank + 1,
						score: row.lexical,
					});
				}
			}
			const vecRank = byVec.findIndex(
				(item) => item.pattern.id === row.pattern.id,
			);
			ranks.push(vecRank + 1);
			channels.push({
				channel: SearchChannel.ONTOLOGY_VECTOR,
				rank: vecRank + 1,
				score: row.vector,
			});
			return {
				pattern: row.pattern,
				score: rrf(ranks),
				vector: row.vector,
				channels,
				exact: row.exactId || row.exactAlias,
			};
		})
		.sort(
			(a, b) => b.score - a.score || a.pattern.id.localeCompare(b.pattern.id),
		);

	const top = fused.slice(0, request.maxResults || 8);
	const best = top[0];
	const second = top[1];
	const uniqueExact = byExact.length === 1 ? byExact[0] : undefined;
	let decision = SearchDecision.ABSTAINED;
	let selected: PatternManifest | undefined;
	let reason = "below-threshold";
	if (
		uniqueExact &&
		(request.autoSelect ||
			request.exactId ||
			request.query === uniqueExact.pattern.id)
	) {
		decision = SearchDecision.SELECTED;
		selected = uniqueExact.pattern;
		reason = "exact-id-or-alias";
	} else if (
		best &&
		best.vector >= SELECT_SCORE &&
		(!second || best.vector - second.vector >= SELECT_MARGIN) &&
		normalized.terms.every(
			(term) =>
				best.pattern.id.toLowerCase().includes(term) ||
				best.pattern.aliases.some((alias) =>
					alias.toLowerCase().includes(term),
				) ||
				best.pattern.intent.toLowerCase().includes(term) ||
				best.pattern.title.toLowerCase().includes(term) ||
				normalized.features.some((feature) => feature.endsWith(`:${term}`)),
		)
	) {
		decision = SearchDecision.SELECTED;
		selected = best.pattern;
		reason = "calibrated-margin";
	} else if (
		top.length === 0 ||
		(best && best.vector < 0.05 && best.score < 0.02)
	) {
		decision = SearchDecision.NOT_FOUND;
		reason = "no-evidence";
	} else if (top.length > 1) {
		decision = SearchDecision.CANDIDATES;
		reason = "ambiguous";
	}

	const unavailable = ftsAvailable ? [] : [SearchChannel.FTS5];
	return create(PatternSearchReceiptSchema, {
		requestDigest: createHash("sha256")
			.update(JSON.stringify(request))
			.digest("hex"),
		catalogDigest: input.catalog.digest,
		vocabularyDigest: input.vocabulary.digest,
		encoderId: input.vocabulary.encoderId,
		encoderDigest: input.vocabulary.digest,
		indexDigest: input.index?.catalogDigest ?? input.catalog.digest,
		channelsExecuted: [
			SearchChannel.EXACT_ID,
			SearchChannel.EXACT_ALIAS,
			SearchChannel.EXACT_SYMBOL,
			SearchChannel.ONTOLOGY_VECTOR,
			...(ftsAvailable ? [SearchChannel.FTS5] : []),
		],
		channelsUnavailable: unavailable,
		candidates: top.map((row, index) => ({
			patternId: row.pattern.id,
			patternVersion: row.pattern.version,
			fusedRank: index + 1,
			channels: row.channels,
			matchedTerms: normalized.terms.filter((term) =>
				`${row.pattern.id} ${row.pattern.intent}`.toLowerCase().includes(term),
			),
			matchedFeatures: row.pattern.features
				.map((feature) => feature.id)
				.filter((id) => normalized.features.includes(id)),
			missingFeatures: [],
			conflicts: [],
			explanation: row.channels
				.map((channel) => `${SearchChannel[channel.channel]}#${channel.rank}`)
				.join(","),
			selectable: row.exact || row.vector >= SELECT_SCORE,
		})),
		decision,
		reasonCode: reason,
		selectedId: selected?.id ?? "",
		selectedVersion: selected?.version ?? 0,
		threshold: SELECT_SCORE,
		margin: SELECT_MARGIN,
		elapsedMs: Date.now() - started,
		llmCalls: 0,
		llmInputTokens: 0,
		llmOutputTokens: 0,
		status:
			decision === SearchDecision.SELECTED
				? ReceiptStatus.ACCEPTED
				: decision === SearchDecision.CANDIDATES
					? ReceiptStatus.AMBIGUOUS
					: ReceiptStatus.REJECTED,
	});
}

export function compileSafeFtsQuery(terms: readonly string[]): string {
	return compileFts(terms);
}

export function explainPatternMatch(input: {
	readonly catalog: PatternCatalog;
	readonly vocabulary: HoboVocabulary;
	readonly query: unknown;
	readonly patternId: string;
	readonly index?: PatternIndex;
}): string {
	const receipt = searchPatterns(input);
	const hit = receipt.candidates.find(
		(item) => item.patternId === input.patternId,
	);
	if (!hit)
		return `${input.patternId}: not in result set (${receipt.reasonCode})`;
	return `${hit.patternId} rank=${hit.fusedRank} ${hit.explanation} terms=${hit.matchedTerms.join("|")} features=${hit.matchedFeatures.join("|")}`;
}

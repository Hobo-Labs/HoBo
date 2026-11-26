import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";

import {
	type PatternCompositionReceipt,
	PatternCompositionReceiptSchema,
	ReceiptStatus,
	SearchDecision,
} from "./_generated/patterns_pb.js";
import type { PatternCatalog } from "./catalog.js";
import { PatternParseError } from "./parse.js";
import { renderPattern } from "./render.js";
import { searchPatterns } from "./retrieve.js";
import type { HoboVocabulary } from "./vocabulary.js";
import { mergeYardTopology } from "./yard-merge.js";

export function composePatterns<P>(input: {
	readonly catalog: PatternCatalog;
	readonly vocabulary: HoboVocabulary;
	readonly query: string;
	readonly params?: Readonly<Record<string, P>>;
}): PatternCompositionReceipt {
	const search = searchPatterns({
		catalog: input.catalog,
		vocabulary: input.vocabulary,
		query: { query: input.query, topK: 12, compose: true },
	});
	const chosen = search.candidates
		.filter((item) => item.selectable)
		.map((item) =>
			input.catalog.patterns.find((pattern) => pattern.id === item.patternId),
		)
		.filter((item): item is NonNullable<typeof item> => item !== undefined);
	const provides = new Set(chosen.flatMap((item) => item.provides));
	const unsatisfied = chosen.flatMap((item) =>
		item.requires.filter((req) => !provides.has(req)),
	);
	const conflicts = chosen.flatMap((item) =>
		item.conflicts.filter((id) => chosen.some((other) => other.id === id)),
	);
	if (unsatisfied.length > 0 || conflicts.length > 0 || chosen.length === 0) {
		return create(PatternCompositionReceiptSchema, {
			requestedFeatures: [],
			chosenIds: chosen.map((item) => item.id),
			rejectedIds: [],
			unsatisfied,
			conflicts,
			effectOrder: [],
			outputDigest: "",
			decision: SearchDecision.INCOMPATIBLE,
			reasonCode: conflicts.length > 0 ? "conflict" : "unsatisfied",
			llmCalls: 0,
			llmInputTokens: 0,
			llmOutputTokens: 0,
			status: ReceiptStatus.REJECTED,
		});
	}
	const remaining = [...chosen];
	const ordered: typeof chosen = [];
	while (remaining.length > 0) {
		const next = remaining.find((item) =>
			item.requires.every((req) =>
				ordered.some((have) => have.provides.includes(req)),
			),
		);
		if (!next) {
			return create(PatternCompositionReceiptSchema, {
				requestedFeatures: [],
				chosenIds: chosen.map((item) => item.id),
				rejectedIds: [],
				unsatisfied: remaining.map((item) => item.id),
				conflicts: ["cycle"],
				effectOrder: [],
				outputDigest: "",
				decision: SearchDecision.INCOMPATIBLE,
				reasonCode: "cycle",
				llmCalls: 0,
				llmInputTokens: 0,
				llmOutputTokens: 0,
				status: ReceiptStatus.REJECTED,
			});
		}
		ordered.push(next);
		remaining.splice(remaining.indexOf(next), 1);
	}
	const files = new Map<string, string>();
	for (const pattern of ordered) {
		const rendered = input.params
			? renderPattern({ catalog: input.catalog, pattern, params: input.params })
			: renderPattern({ catalog: input.catalog, pattern });
		for (const file of rendered.files) {
			const previous = files.get(file.path);
			if (previous === undefined) {
				files.set(file.path, file.contents);
				continue;
			}
			if (previous === file.contents) continue;
			try {
				if (!file.path.endsWith(".ts") || !previous.includes("yard("))
					throw new PatternParseError("same-path patterns cannot be merged");
				files.set(file.path, mergeYardTopology(previous, file.contents));
			} catch (error) {
				if (!(error instanceof PatternParseError)) throw error;
				return create(PatternCompositionReceiptSchema, {
					requestedFeatures: [],
					chosenIds: ordered.map((item) => item.id),
					rejectedIds: [],
					unsatisfied: [],
					conflicts: [file.path],
					effectOrder: [],
					outputDigest: "",
					decision: SearchDecision.INCOMPATIBLE,
					reasonCode: "conflict",
					llmCalls: 0,
					llmInputTokens: 0,
					llmOutputTokens: 0,
					status: ReceiptStatus.REJECTED,
				});
			}
		}
	}
	const digest = createHash("sha256")
		.update([...files.values()].join("\n"))
		.digest("hex");
	return create(PatternCompositionReceiptSchema, {
		requestedFeatures: [],
		chosenIds: ordered.map((item) => item.id),
		rejectedIds: [],
		unsatisfied: [],
		conflicts: [],
		effectOrder: ordered.flatMap((item) =>
			item.effects.map((effect) => effect.id),
		),
		outputDigest: digest,
		decision: SearchDecision.SELECTED,
		reasonCode: "covered",
		llmCalls: 0,
		llmInputTokens: 0,
		llmOutputTokens: 0,
		status: ReceiptStatus.ACCEPTED,
	});
}

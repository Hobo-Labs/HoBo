import { createHash } from "node:crypto";

import type { PatternManifest } from "./_generated/patterns_pb.js";
import {
	cosineSimilarity,
	decodeVectorBlob,
	type EncodedVector,
	encodeVectorBlob,
} from "./vector-codec.js";
import type { HoboVocabulary } from "./vocabulary.js";

export type { EncodedVector } from "./vector-codec.js";
export { cosineSimilarity, decodeVectorBlob, encodeVectorBlob };

export function encodeOntologyVector(
	features:
		| readonly string[]
		| readonly { readonly id: string; readonly weight: number }[],
	vocabulary: HoboVocabulary,
): EncodedVector {
	const values = new Float32Array(vocabulary.features.length);
	const index = new Map(vocabulary.features.map((id, i) => [id, i]));
	for (const feature of features) {
		const id = typeof feature === "string" ? feature : feature.id;
		const weight = typeof feature === "string" ? 1 : feature.weight;
		const at = index.get(id);
		if (at === undefined) continue;
		if (!Number.isFinite(weight) || weight < 0) {
			throw new Error(`invalid feature weight for ${id}`);
		}
		values[at] = (values[at] ?? 0) + weight;
	}
	let norm = 0;
	for (const value of values) norm += value * value;
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let i = 0; i < values.length; i++) {
			values[i] = (values[i] ?? 0) / norm;
		}
	}
	return {
		encoderId: vocabulary.encoderId,
		dimensions: values.length,
		values,
	};
}

export function encodePatternDocument(
	pattern: PatternManifest,
	vocabulary: HoboVocabulary,
): EncodedVector {
	const weighted: { id: string; weight: number }[] = [
		...pattern.features,
		...pattern.provides.map((id) => ({ id, weight: 0.4 })),
		...pattern.requires.map((id) => ({ id, weight: 0.2 })),
		...pattern.aliases.flatMap((alias) => {
			const mapped = vocabulary.aliases[alias] ?? [];
			return mapped.map((id) => ({ id, weight: 0.25 }));
		}),
	];
	return encodeOntologyVector(weighted, vocabulary);
}

export function digestBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CATALOG } from "@hobo/bindles";
import { BINDLE_PRIMITIVES, BINDLE_RUNTIMES } from "@hobo/capability-profiles";

export type HoboVocabulary = {
	readonly encoderId: string;
	readonly digest: string;
	readonly features: readonly string[];
	readonly aliases: Readonly<Record<string, readonly string[]>>;
};

// public-contract: ontology-vector encoder identity pinned by receipts.
export const ONTOLOGY_ENCODER_ID = "hobo-ontology-vector-v1" as const;

export function defaultAliasPath(): string {
	return join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"vocabulary",
		"aliases.json",
	);
}

export function buildHoboVocabulary(
	options: { readonly aliasPath?: string } = {},
): HoboVocabulary {
	const features = new Set<string>();
	for (const row of CATALOG) {
		features.add(`authoring-resource:${row.factory}`);
		for (const verb of row.allowVerbs) {
			features.add(`allowance:${row.factory}:${verb}`);
		}
	}
	for (const primitive of BINDLE_PRIMITIVES) {
		features.add(`capability-primitive:${primitive}`);
	}
	for (const runtime of BINDLE_RUNTIMES) {
		features.add(`runtime:${runtime}`);
	}
	for (const extra of [
		"artifact:bindle",
		"artifact:agent",
		"artifact:yard",
		"artifact:starter",
		"relation:depends-on",
		"constraint:provider-neutral",
		"constraint:least-privilege",
		"constraint:no-local-secret",
		"property:durable",
		"property:offline",
		"output:snippet",
		"output:file",
		"output:project",
		"profile:data.postgres/v1",
		"context:bindle-builder",
		"context:new-file",
		"context:existing-typescript",
	]) {
		features.add(extra);
	}
	const sorted = [...features].sort((a, b) => a.localeCompare(b));
	const aliasPath = options.aliasPath ?? defaultAliasPath();
	const aliases = existsSync(aliasPath)
		? (JSON.parse(readFileSync(aliasPath, "utf8")) as Record<string, string[]>)
		: {};
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				encoder: ONTOLOGY_ENCODER_ID,
				features: sorted,
				aliases,
			}),
		)
		.digest("hex");
	return {
		encoderId: ONTOLOGY_ENCODER_ID,
		digest,
		features: sorted,
		aliases,
	};
}

export function normalizePatternQuery(
	query: string,
	vocabulary: HoboVocabulary,
): { readonly terms: readonly string[]; readonly features: readonly string[] } {
	const terms = query
		.toLowerCase()
		.replace(/[^a-z0-9:./+-]+/gu, " ")
		.trim()
		.split(/\s+/u)
		.filter((term) => term.length > 0 && !STOP.has(term));
	const features = new Set<string>();
	for (const term of terms) {
		for (const [alias, mapped] of Object.entries(vocabulary.aliases)) {
			if (term === alias || query.toLowerCase().includes(alias)) {
				for (const feature of mapped) features.add(feature);
			}
		}
		for (const feature of vocabulary.features) {
			if (feature.endsWith(`:${term}`) || feature.includes(`:${term}:`)) {
				features.add(feature);
			}
		}
	}
	return { terms, features: [...features].sort() };
}

const STOP = new Set([
	"a",
	"an",
	"the",
	"to",
	"and",
	"or",
	"of",
	"with",
	"for",
	"by",
]);

import { type BundleManifest, bundleManifestDigest } from "./ingest.js";

// Search/index: a small pure module — an in-memory
// index over ingested bundles queryable by name, capability, and provider
// with deterministic ranking (fixed scores, codepoint tie-breaks). No IO,
// no clock, no randomness: equal inputs always rank equally.

// Derived from a parsed BundleManifest only; the proto message is its wire form.
// domain-view: parsed derived type of data-models BundleIndexEntry
export interface BundleIndexEntry {
	name: string;
	version: string;
	provider: string;
	ports: readonly string[];
	manifestDigest: string;
}

export interface BundleSearchQuery {
	name?: string;
	capability?: string;
	provider?: string;
}

export interface RankedBundle {
	score: number;
	entry: BundleIndexEntry;
}

// Project a parsed manifest onto its search-index row.
export function toIndexEntry(manifest: BundleManifest): BundleIndexEntry {
	return {
		name: manifest.name,
		version: manifest.version,
		provider: manifest.provider,
		ports: [...new Set(manifest.capabilities.map((c) => c.port))].sort(),
		manifestDigest: bundleManifestDigest(manifest),
	};
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function nameScore(entryName: string, query: string): number {
	const name = entryName.toLowerCase();
	const needle = query.toLowerCase();
	if (name === needle) return 100;
	if (name.startsWith(needle)) return 60;
	if (name.includes(needle)) return 30;
	return -1;
}

// Rank index entries against a query. Every provided criterion must match
// (capability and provider exactly, name by exact/prefix/substring); an empty
// query matches nothing. Ties break by name, then version, then provider
// (codepoint order), so results are stable across runs.
export function searchBundles(
	entries: readonly BundleIndexEntry[],
	query: BundleSearchQuery,
): RankedBundle[] {
	if (
		query.name === undefined &&
		query.capability === undefined &&
		query.provider === undefined
	) {
		return [];
	}

	const ranked: RankedBundle[] = [];
	for (const entry of entries) {
		let score = 0;
		if (query.name !== undefined) {
			const s = nameScore(entry.name, query.name);
			if (s < 0) continue;
			score += s;
		}
		if (query.capability !== undefined) {
			if (!entry.ports.includes(query.capability)) continue;
			score += 25;
		}
		if (query.provider !== undefined) {
			if (entry.provider !== query.provider) continue;
			score += 15;
		}
		ranked.push({ score, entry: { ...entry, ports: [...entry.ports] } });
	}

	ranked.sort(
		(a, b) =>
			b.score - a.score ||
			compare(a.entry.name, b.entry.name) ||
			compare(a.entry.version, b.entry.version) ||
			compare(a.entry.provider, b.entry.provider),
	);
	return ranked;
}

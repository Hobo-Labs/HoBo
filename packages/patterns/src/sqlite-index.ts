// SQLite is a derived index / materialized view / read-store of the catalog.
// Catalog files remain the source of truth. Search is a command; receipts are
// events. This package is not an actor host and does not own an event-store.

import {
	existsSync,
	mkdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
	asBytes,
	asNumber,
	asText,
	createMemoryNodeSqliteDriver,
	createNodeSqliteDriver,
	type SqliteDriver,
} from "@hobo/storage-sqlite";

import type { PatternCatalog } from "./catalog.js";
import { encodePatternDocument, encodeVectorBlob } from "./encode.js";
import { canonicalJson } from "./parse.js";
import { vectorCodecId } from "./vector-codec.js";
import type { HoboVocabulary } from "./vocabulary.js";

const SCHEMA_SQL = `
CREATE TABLE catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE patterns (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  maturity INTEGER NOT NULL,
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  description TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE pattern_aliases (
  pattern_id TEXT NOT NULL,
  pattern_version INTEGER NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  exact_unique INTEGER NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (pattern_id, pattern_version, normalized_alias)
);
CREATE TABLE pattern_symbols (
  pattern_id TEXT NOT NULL,
  pattern_version INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  normalized_symbol TEXT NOT NULL,
  weight REAL NOT NULL
);
CREATE TABLE pattern_features (
  pattern_id TEXT NOT NULL,
  pattern_version INTEGER NOT NULL,
  feature_id TEXT NOT NULL,
  weight REAL NOT NULL,
  source INTEGER NOT NULL,
  PRIMARY KEY (pattern_id, pattern_version, feature_id, source)
);
CREATE TABLE pattern_renderings (
  pattern_id TEXT NOT NULL,
  pattern_version INTEGER NOT NULL,
  rendering_id TEXT NOT NULL,
  rendering_kind INTEGER NOT NULL,
  language TEXT NOT NULL,
  context TEXT NOT NULL,
  body BLOB NOT NULL,
  body_digest TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (pattern_id, pattern_version, rendering_id)
);
CREATE TABLE pattern_vectors (
  pattern_id TEXT NOT NULL,
  pattern_version INTEGER NOT NULL,
  encoder_id TEXT NOT NULL,
  encoder_digest TEXT NOT NULL,
  vocabulary_digest TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  codec TEXT NOT NULL,
  normalized INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (pattern_id, pattern_version, encoder_id)
);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE pattern_fts USING fts5(
  pattern_id,
  title,
  intent,
  description,
  aliases,
  features,
  symbols,
  tokenize = 'unicode61'
);
`;

export type PatternIndex = {
	readonly catalogDigest: string;
	readonly vocabularyDigest: string;
	readonly encoderId: string;
	readonly ftsAvailable: boolean;
	readonly driver: SqliteDriver;
	close(): void;
};

export type PatternIndexBuildReceipt = {
	readonly catalogDigest: string;
	readonly vocabularyDigest: string;
	readonly encoderId: string;
	readonly encoderDigest: string;
	readonly schemaVersion: string;
	readonly path: string;
	readonly patternCount: number;
	readonly ftsAvailable: boolean;
	readonly llmCalls: 0;
	readonly llmInputTokens: 0;
	readonly llmOutputTokens: 0;
};

export type IndexLexicalHit = {
	readonly patternId: string;
	readonly rank: number;
	readonly score: number;
};

export type IndexVectorRow = {
	readonly patternId: string;
	readonly patternVersion: number;
	readonly dimensions: number;
	readonly blob: Uint8Array;
};

function probeFts(driver: SqliteDriver): boolean {
	try {
		driver.exec("CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x)");
		driver.exec("DROP TABLE IF EXISTS temp.fts_probe");
		return true;
	} catch {
		return false;
	}
}

function setMeta(driver: SqliteDriver, key: string, value: string): void {
	driver
		.prepare("INSERT INTO catalog_meta(key, value) VALUES (?, ?)")
		.run(key, value);
}

function populate(
	driver: SqliteDriver,
	catalog: PatternCatalog,
	vocabulary: HoboVocabulary,
	ftsAvailable: boolean,
): void {
	driver.exec(SCHEMA_SQL);
	if (ftsAvailable) driver.exec(FTS_SQL);
	const insertPattern = driver.prepare(
		`INSERT INTO patterns(id, version, kind, maturity, title, intent, description, manifest_json, content_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertAlias = driver.prepare(
		`INSERT INTO pattern_aliases(pattern_id, pattern_version, alias, normalized_alias, exact_unique, weight)
     VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const insertSymbol = driver.prepare(
		`INSERT INTO pattern_symbols(pattern_id, pattern_version, symbol, normalized_symbol, weight)
     VALUES (?, ?, ?, ?, ?)`,
	);
	const insertFeature = driver.prepare(
		`INSERT INTO pattern_features(pattern_id, pattern_version, feature_id, weight, source)
     VALUES (?, ?, ?, ?, ?)`,
	);
	const insertVector = driver.prepare(
		`INSERT INTO pattern_vectors(pattern_id, pattern_version, encoder_id, encoder_digest, vocabulary_digest, dimensions, codec, normalized, vector)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertFts = ftsAvailable
		? driver.prepare(
				`INSERT INTO pattern_fts(pattern_id, title, intent, description, aliases, features, symbols)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
		: undefined;

	const sorted = [...catalog.patterns].sort(
		(a, b) => a.id.localeCompare(b.id) || b.version - a.version,
	);
	for (const pattern of sorted) {
		insertPattern.run(
			pattern.id,
			pattern.version,
			pattern.kind,
			pattern.maturity,
			pattern.title,
			pattern.intent,
			pattern.description,
			canonicalJson(pattern),
			pattern.contentDigest,
		);
		const seenAlias = new Set<string>();
		for (const alias of pattern.aliases) {
			const normalized = alias.trim().toLowerCase();
			if (seenAlias.has(normalized)) continue;
			seenAlias.add(normalized);
			insertAlias.run(pattern.id, pattern.version, alias, normalized, 1, 1);
		}
		for (const symbol of pattern.apiSymbols) {
			insertSymbol.run(
				pattern.id,
				pattern.version,
				symbol,
				symbol.toLowerCase(),
				1,
			);
		}
		for (const feature of pattern.features) {
			insertFeature.run(
				pattern.id,
				pattern.version,
				feature.id,
				feature.weight,
				1,
			);
		}
		const vector = encodePatternDocument(pattern, vocabulary);
		insertVector.run(
			pattern.id,
			pattern.version,
			vocabulary.encoderId,
			vocabulary.digest,
			vocabulary.digest,
			vector.dimensions,
			vectorCodecId(),
			1,
			encodeVectorBlob(vector),
		);
		insertFts?.run(
			pattern.id,
			pattern.title,
			pattern.intent,
			pattern.description,
			pattern.aliases.join(" "),
			pattern.features.map((item) => item.id).join(" "),
			pattern.apiSymbols.join(" "),
		);
	}
	setMeta(driver, "schema_version", "patterns-index-v1");
	setMeta(driver, "catalog_digest", catalog.digest);
	setMeta(driver, "vocabulary_digest", vocabulary.digest);
	setMeta(driver, "encoder_id", vocabulary.encoderId);
	setMeta(driver, "encoder_digest", vocabulary.digest);
	setMeta(driver, "dimensions", String(vocabulary.features.length));
	setMeta(driver, "codec", vectorCodecId());
	setMeta(driver, "fts5", ftsAvailable ? "1" : "0");
	setMeta(driver, "pattern_count", String(sorted.length));
}

function wrapIndex(driver: SqliteDriver): PatternIndex {
	const meta = new Map(
		driver
			.prepare("SELECT key, value FROM catalog_meta")
			.all()
			.map((row) => [asText(row.key, "key"), asText(row.value, "value")]),
	);
	const catalogDigest = meta.get("catalog_digest");
	const vocabularyDigest = meta.get("vocabulary_digest");
	const encoderId = meta.get("encoder_id");
	if (!catalogDigest || !vocabularyDigest || !encoderId) {
		driver.close();
		throw new Error("pattern index missing required catalog_meta");
	}
	return {
		catalogDigest,
		vocabularyDigest,
		encoderId,
		ftsAvailable: meta.get("fts5") === "1",
		driver,
		close() {
			driver.close();
		},
	};
}

export function buildPatternIndex(input: {
	readonly catalog: PatternCatalog;
	readonly vocabulary: HoboVocabulary;
	readonly path?: string;
}): PatternIndexBuildReceipt {
	const memory = input.path === undefined;
	const path = input.path ?? ":memory:";
	const tmp = memory ? "" : `${path}.tmp-${process.pid}`;
	if (tmp) mkdirSync(dirname(tmp), { recursive: true });
	const driver = tmp
		? createNodeSqliteDriver({ path: tmp, disableExtensions: true })
		: createMemoryNodeSqliteDriver({ disableExtensions: true });
	try {
		driver.beginImmediate();
		const ftsAvailable = probeFts(driver);
		populate(driver, input.catalog, input.vocabulary, ftsAvailable);
		driver.commit();
		const integrity = String(driver.pragma("integrity_check") ?? "");
		if (integrity !== "ok" && integrity !== "") {
			throw new Error(`pattern index integrity_check failed: ${integrity}`);
		}
		if (tmp && input.path) {
			driver.close();
			renameSync(tmp, input.path);
			writeFileSync(
				join(dirname(input.path), "catalog.json"),
				canonicalJson({
					digest: input.catalog.digest,
					ids: input.catalog.patterns.map((item) => item.id),
				}),
			);
			return {
				catalogDigest: input.catalog.digest,
				vocabularyDigest: input.vocabulary.digest,
				encoderId: input.vocabulary.encoderId,
				encoderDigest: input.vocabulary.digest,
				schemaVersion: "patterns-index-v1",
				path: input.path,
				patternCount: input.catalog.patterns.length,
				ftsAvailable,
				llmCalls: 0,
				llmInputTokens: 0,
				llmOutputTokens: 0,
			};
		}
		driver.close();
		return {
			catalogDigest: input.catalog.digest,
			vocabularyDigest: input.vocabulary.digest,
			encoderId: input.vocabulary.encoderId,
			encoderDigest: input.vocabulary.digest,
			schemaVersion: "patterns-index-v1",
			path,
			patternCount: input.catalog.patterns.length,
			ftsAvailable,
			llmCalls: 0,
			llmInputTokens: 0,
			llmOutputTokens: 0,
		};
	} catch (error) {
		try {
			driver.rollback();
		} catch {
			// ignore rollback after failed transaction
		}
		driver.close();
		if (tmp && existsSync(tmp)) unlinkSync(tmp);
		throw error;
	}
}

export function openPatternIndex(input: {
	readonly path?: string;
	readonly catalog?: PatternCatalog;
	readonly vocabulary?: HoboVocabulary;
}): PatternIndex {
	if (input.path && existsSync(input.path)) {
		return wrapIndex(
			createNodeSqliteDriver({ path: input.path, disableExtensions: true }),
		);
	}
	if (!input.catalog || !input.vocabulary) {
		throw new Error("pattern index missing and catalog fallback not provided");
	}
	const driver = createMemoryNodeSqliteDriver({ disableExtensions: true });
	driver.beginImmediate();
	const ftsAvailable = probeFts(driver);
	populate(driver, input.catalog, input.vocabulary, ftsAvailable);
	driver.commit();
	return wrapIndex(driver);
}

export function searchIndexLexical(
	index: PatternIndex,
	terms: readonly string[],
): readonly IndexLexicalHit[] {
	if (terms.length === 0) return [];
	if (index.ftsAvailable) {
		const query = terms
			.map((term) => `"${term.replaceAll('"', "")}"`)
			.join(" ");
		const rows = index.driver
			.prepare(
				`SELECT pattern_id AS patternId, bm25(pattern_fts, 2.0, 1.0, 1.0, 0.5, 2.0, 1.5, 2.0) AS score
         FROM pattern_fts WHERE pattern_fts MATCH ? ORDER BY score, pattern_id`,
			)
			.all(query);
		return rows.map((row, rank) => ({
			patternId: asText(row.patternId, "patternId"),
			rank: rank + 1,
			score: -asNumber(row.score, "score"),
		}));
	}
	const rows = index.driver
		.prepare("SELECT id, title, intent, description FROM patterns")
		.all();
	const scored = rows
		.map((row) => {
			const hay =
				`${row.id} ${row.title} ${row.intent} ${row.description}`.toLowerCase();
			const score = terms.filter((term) => hay.includes(term)).length;
			return { patternId: asText(row.id, "id"), score };
		})
		.filter((row) => row.score > 0)
		.sort(
			(a, b) => b.score - a.score || a.patternId.localeCompare(b.patternId),
		);
	return scored.map((row, rank) => ({ ...row, rank: rank + 1 }));
}

export function loadIndexVectors(
	index: PatternIndex,
): readonly IndexVectorRow[] {
	return index.driver
		.prepare(
			"SELECT pattern_id, pattern_version, dimensions, vector FROM pattern_vectors",
		)
		.all()
		.map((row) => ({
			patternId: asText(row.pattern_id, "pattern_id"),
			patternVersion: asNumber(row.pattern_version, "pattern_version"),
			dimensions: asNumber(row.dimensions, "dimensions"),
			blob: asBytes(row.vector, "vector"),
		}));
}

export function defaultIndexPath(packageRoot: string): string {
	return join(packageRoot, "dist", "assets", "patterns.sqlite");
}

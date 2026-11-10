import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyPatternPlan,
	buildHoboVocabulary,
	buildPatternIndex,
	buildVsCodeSnippets,
	compileSafeFtsQuery,
	composePatterns,
	cosineSimilarity,
	decodeVectorBlob,
	encodeOntologyVector,
	encodeVectorBlob,
	explainPatternMatch,
	loadPatternCatalog,
	ONTOLOGY_ENCODER_ID,
	openPatternIndex,
	PatternParseError,
	parsePatternManifest,
	parsePatternQuery,
	parseRenderRequest,
	planPatternApplication,
	rejectModel2Vec,
	renderCliStarterFiles,
	renderPattern,
	searchPatterns,
	validatePatternCatalog,
} from "../src/index.js";

const catalog = loadPatternCatalog();
const vocabulary = buildHoboVocabulary();

describe("@hobo/patterns", () => {
	it("loads every required initial pattern id", () => {
		const ids = new Set(catalog.patterns.map((item) => item.id));
		for (const id of [
			"bindle.named",
			"bindle.resource.api",
			"bindle.resource.web",
			"bindle.resource.kv-read-write",
			"bindle.resource.queue-producer",
			"bindle.relationship.depends-on",
			"bindle.relationship.multiple-dependencies",
			"bindle.annotation.env",
			"bindle.topology.web-api",
			"bindle.topology.web-api-kv-queue",
			"bindle.guidance.provider-neutral",
			"bindle.validation.manifest-determinism",
			"adapter.hono.entrypoint",
			"connector.declare",
			"agent.declare",
			"yard.self-hosted.open",
			"starter.cli.todo",
			"starter.cli.api",
			"starter.cli.agent",
			"starter.cli.fullstack",
			"bindle.web-api",
			"bindle.web-only",
			"http.api.hello",
			"station.init",
			"arch.proto-cue-pair",
		]) {
			expect(ids.has(id), id).toBe(true);
		}
		expect(catalog.digest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects an empty manifest", () => {
		expect(() => parsePatternManifest({})).toThrow(PatternParseError);
	});

	it("selects an exact pattern id with zero LLM usage", () => {
		const receipt = searchPatterns({
			catalog,
			vocabulary,
			query: "bindle.topology.web-api",
		});
		expect(receipt.selectedId).toBe("bindle.topology.web-api");
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
		expect(receipt.encoderId).toBe(ONTOLOGY_ENCODER_ID);
	});

	it("finds a web/api topology from natural language", () => {
		const receipt = searchPatterns({
			catalog,
			vocabulary,
			query: "web frontend backed by an api",
		});
		expect(receipt.candidates.map((item) => item.patternId)).toContain(
			"bindle.topology.web-api",
		);
	});

	it("abstains on a negative query", () => {
		const receipt = searchPatterns({
			catalog,
			vocabulary,
			query: "quantum compiler backend",
		});
		expect(receipt.selectedId).toBe("");
	});

	it("still searches when FTS is unavailable", () => {
		const receipt = searchPatterns({
			catalog,
			vocabulary,
			query: "bindle.named",
			ftsAvailable: false,
		});
		expect(receipt.selectedId).toBe("bindle.named");
		expect(receipt.channelsUnavailable.length).toBeGreaterThan(0);
	});

	it("compiles quoted FTS terms and never interpolates raw user syntax", () => {
		expect(compileSafeFtsQuery(["web", 'api" OR'])).toBe('"web" "api OR"');
	});

	it("encodes L2-normalized ontology vectors of equal dimension", () => {
		const left = encodeOntologyVector(["authoring-resource:web"], vocabulary);
		const right = encodeOntologyVector(["authoring-resource:api"], vocabulary);
		expect(left.dimensions).toBe(vocabulary.features.length);
		expect(cosineSimilarity(left, left)).toBeCloseTo(1);
		expect(cosineSimilarity(left, right)).toBeLessThan(1);
	});

	it("renders typed parameters and rejects path escape", () => {
		const pattern = catalog.patterns.find((item) => item.id === "bindle.named");
		assert(pattern, "catalog is missing the bindle.named pattern");
		const rendered = renderPattern({
			catalog,
			pattern,
			params: { resourceName: "shop" },
		});
		expect(rendered.files[0]?.contents).toContain('bindle("shop"');
		expect(rendered.llmCalls).toBe(0);
		expect(() =>
			renderPattern({
				catalog,
				pattern,
				params: { resourceName: "../etc" },
			}),
		).toThrow(PatternParseError);
	});

	it("composes web+api+kv+queue without concatenating blindly", () => {
		const receipt = composePatterns({
			catalog,
			vocabulary,
			query: "web app with an api, read-write kv, and order queue",
		});
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.chosenIds.length).toBeGreaterThan(0);
	});

	it("applies into an isolation root and is idempotent", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-pat-"));
		const first = applyPatternPlan({
			catalog,
			patternId: "bindle.named",
			isolationRoot: root,
			targetPath: "src/bindle.ts",
			isolationRunId: "run-1",
			params: { resourceName: "demo" },
		});
		expect(first.changedFiles).toEqual(["src/bindle.ts"]);
		expect(first.promotionRequired).toBe(true);
		const second = applyPatternPlan({
			catalog,
			patternId: "bindle.named",
			isolationRoot: root,
			targetPath: "src/bindle.ts",
			isolationRunId: "run-2",
			params: { resourceName: "demo" },
		});
		expect(second.idempotent).toBe(true);
		expect(readFileSync(join(root, "src/bindle.ts"), "utf8")).toContain(
			'bindle("demo"',
		);
	});

	it("records the Model2Vec rejection instead of shipping a stub encoder", () => {
		expect(rejectModel2Vec().adopted).toBe(false);
	});

	it("parses a search object query", () => {
		const parsed = parsePatternQuery({ query: "kv", topK: 3 });
		expect(parsed.query).toBe("kv");
		expect(parsed.maxResults).toBe(3);
	});

	it("round-trips little-endian vector blobs", () => {
		const vector = encodeOntologyVector(["authoring-resource:web"], vocabulary);
		const blob = encodeVectorBlob(vector);
		const decoded = decodeVectorBlob(blob, vector.dimensions, vector.encoderId);
		expect(cosineSimilarity(vector, decoded)).toBeCloseTo(1);
	});

	it("builds and searches a SQLite index without loading extensions", () => {
		const index = openPatternIndex({ catalog, vocabulary });
		expect(index.catalogDigest).toBe(catalog.digest);
		const receipt = searchPatterns({
			catalog,
			vocabulary,
			query: "bindle.named",
			index,
		});
		expect(receipt.selectedId).toBe("bindle.named");
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.indexDigest).toBe(catalog.digest);
		index.close();
		const built = buildPatternIndex({ catalog, vocabulary });
		expect(built.patternCount).toBe(catalog.patterns.length);
		expect(built.llmCalls).toBe(0);
	});

	it("validates the catalog and emits VS Code snippets", {
		timeout: 30_000,
	}, () => {
		const report = validatePatternCatalog({ catalog });
		expect(report.ok, report.issues.join("\n")).toBe(true);
		const snippets = buildVsCodeSnippets({ catalog });
		expect(snippets.count).toBeGreaterThan(10);
		expect(snippets.llmCalls).toBe(0);
	});

	it("plans application before writing and fails closed on unsupported shapes", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-pat-plan-"));
		const plan = planPatternApplication({
			catalog,
			patternId: "bindle.named",
			isolationRoot: root,
			targetPath: "src/bindle.ts",
			isolationRunId: "plan-1",
			params: { resourceName: "demo" },
		});
		expect(plan.promotionRequired).toBe(true);
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "bindle.ts"), "export const x = 1;\n");
		expect(() =>
			applyPatternPlan({
				catalog,
				patternId: "bindle.named",
				isolationRoot: root,
				targetPath: "src/bindle.ts",
				isolationRunId: "plan-2",
				params: { resourceName: "demo" },
			}),
		).toThrow(/unsupported existing TypeScript shape/);
	});

	it("renders CLI starter files from the catalog", () => {
		const files = renderCliStarterFiles({ name: "shop", template: "todo" });
		expect(files.get("app.ts")).toContain('template: "todo"');
	});
	it.each([
		"todo",
		"api",
		"agent",
		"fullstack",
	] as const)("ignores codegen/build recovery state in the %s starter", (template) => {
		const files = renderCliStarterFiles({ name: "shop", template });
		expect(files.get(".gitignore")).toContain(
			".hobo-codegen.lock\n.hobo-codegen.lock-*\n.hobo-codegen-*\n",
		);
	});

	it("explains a match", () => {
		const text = explainPatternMatch({
			catalog,
			vocabulary,
			query: "bindle.named",
			patternId: "bindle.named",
		});
		expect(text).toContain("bindle.named");
	});

	it("parses a render request", () => {
		const parsed = parseRenderRequest({
			id: "bindle.named",
			params: { resourceName: "x" },
		});
		expect(parsed.patternId).toBe("bindle.named");
	});

	it("resolves hobo new compatibility aliases before concept aliases", () => {
		expect(
			searchPatterns({
				catalog,
				vocabulary,
				query: "api",
			}).selectedId,
		).toBe("starter.cli.api");
		expect(
			searchPatterns({
				catalog,
				vocabulary,
				query: "agent",
			}).selectedId,
		).toBe("starter.cli.agent");
	});

	it("hard filters cannot be overridden by similarity", () => {
		const receipt = searchPatterns({
			catalog,
			vocabulary,
			query: {
				query: "bindle.named",
				kind: "starter",
				autoSelect: true,
			},
		});
		expect(receipt.selectedId).toBe("");
		expect(
			receipt.candidates.every((item) => item.patternId.startsWith("starter.")),
		).toBe(true);
	});
});

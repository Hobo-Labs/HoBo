import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterAll, describe, expect, it } from "vitest";

import {
	PatternKind,
	type PatternManifest,
	PatternManifestSchema,
	PatternMaturity,
	ReceiptStatus,
	RenderingKind,
	SearchDecision,
} from "../src/_generated/patterns_pb.js";
import type { PatternCatalog } from "../src/catalog.js";
import { composePatterns } from "../src/compose.js";
import { buildHoboVocabulary } from "../src/vocabulary.js";

const vocabulary = buildHoboVocabulary();
const ALIAS = "compose-probe";

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function pattern(input: {
	id: string;
	provides?: string[];
	requires?: string[];
	conflicts?: string[];
	effects?: string[];
	body?: string;
}): PatternManifest {
	if (input.body !== undefined) bodies.set(input.id, input.body);
	return create(PatternManifestSchema, {
		id: input.id,
		version: "1.0.0",
		kind: PatternKind.GUIDANCE,
		maturity: PatternMaturity.STABLE,
		title: input.id,
		intent: `intent for ${input.id}`,
		aliases: [ALIAS],
		provides: input.provides ?? [],
		requires: input.requires ?? [],
		conflicts: input.conflicts ?? [],
		effects: (input.effects ?? []).map((id) => ({ id, description: id })),
		parameters: [],
		renderings: [
			{
				renderingId: `${input.id}.md`,
				kind: RenderingKind.MARKDOWN,
				isDefault: true,
				outputFiles: [`docs/${input.id}.md`],
				sourcePath: "body.md",
			},
		],
	});
}

const bodies = new Map<string, string>();

function catalogOf(patterns: PatternManifest[]): PatternCatalog {
	const root = mkdtempSync(join(tmpdir(), "hobo-patterns-compose-"));
	roots.push(root);
	for (const item of patterns) {
		const dir = join(root, item.id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "pattern.json"),
			JSON.stringify({ id: item.id }),
			"utf8",
		);
		writeFileSync(
			join(dir, "body.md"),
			bodies.get(item.id) ?? `# ${item.id}\n`,
			"utf8",
		);
	}
	return { root, digest: "catalog-digest", patterns };
}

function compose(patterns: PatternManifest[], query = ALIAS) {
	return composePatterns({
		catalog: catalogOf(patterns),
		vocabulary,
		query,
	});
}

describe("rejections", () => {
	it("rejects with reasonCode unsatisfied when nothing was selectable", () => {
		const receipt = compose([], "nothing matches this");
		expect(receipt.status).toBe(ReceiptStatus.REJECTED);
		expect(receipt.decision).toBe(SearchDecision.INCOMPATIBLE);
		expect(receipt.reasonCode).toBe("unsatisfied");
		expect(receipt.chosenIds).toEqual([]);
		expect(receipt.outputDigest).toBe("");
		expect(receipt.effectOrder).toEqual([]);
	});

	it("rejects with reasonCode unsatisfied when a requirement is provided by nobody", () => {
		const receipt = compose([
			pattern({ id: "a.needs", requires: ["cap.store"] }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.REJECTED);
		expect(receipt.reasonCode).toBe("unsatisfied");
		expect(receipt.unsatisfied).toEqual(["cap.store"]);
	});

	it("names every unsatisfied requirement, not just the first", () => {
		const receipt = compose([
			pattern({ id: "a.needs", requires: ["cap.one", "cap.two"] }),
		]);
		expect(receipt.unsatisfied).toEqual(["cap.one", "cap.two"]);
	});

	it("treats a requirement satisfied by any chosen pattern as satisfied", () => {
		const receipt = compose([
			pattern({ id: "a.provider", provides: ["cap.store"] }),
			pattern({ id: "b.consumer", requires: ["cap.store"] }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.ACCEPTED);
		expect(receipt.unsatisfied).toEqual([]);
	});

	it("rejects with reasonCode conflict when two chosen patterns conflict", () => {
		const receipt = compose([
			pattern({ id: "a.one", conflicts: ["b.two"] }),
			pattern({ id: "b.two" }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.REJECTED);
		expect(receipt.reasonCode).toBe("conflict");
		expect(receipt.conflicts).toEqual(["b.two"]);
	});

	it("reports conflict rather than unsatisfied when both are present", () => {
		const receipt = compose([
			pattern({ id: "a.one", conflicts: ["b.two"], requires: ["cap.missing"] }),
			pattern({ id: "b.two" }),
		]);
		expect(receipt.reasonCode).toBe("conflict");
		expect(receipt.conflicts).toContain("b.two");
		expect(receipt.unsatisfied).toContain("cap.missing");
	});

	it("ignores a conflict naming a pattern that was not chosen", () => {
		const receipt = compose([
			pattern({ id: "a.one", conflicts: ["z.not-selected"] }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.ACCEPTED);
		expect(receipt.conflicts).toEqual([]);
	});

	it("still lists the chosen ids on a rejection", () => {
		const receipt = compose([
			pattern({ id: "a.one", conflicts: ["b.two"] }),
			pattern({ id: "b.two" }),
		]);
		expect(receipt.chosenIds).toEqual(["a.one", "b.two"]);
	});

	it("reports zero LLM usage on every rejection", () => {
		const receipt = compose([
			pattern({ id: "a.needs", requires: ["cap.missing"] }),
		]);
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
	});
});

describe("cycle detection", () => {
	it("reports a two-pattern cycle rather than spinning", () => {
		const receipt = compose([
			pattern({ id: "a.one", provides: ["cap.a"], requires: ["cap.b"] }),
			pattern({ id: "b.two", provides: ["cap.b"], requires: ["cap.a"] }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.REJECTED);
		expect(receipt.reasonCode).toBe("cycle");
		expect(receipt.conflicts).toEqual(["cycle"]);
	});

	it("names the patterns it could not place", () => {
		const receipt = compose([
			pattern({ id: "a.one", provides: ["cap.a"], requires: ["cap.b"] }),
			pattern({ id: "b.two", provides: ["cap.b"], requires: ["cap.a"] }),
		]);
		expect([...receipt.unsatisfied].sort()).toEqual(["a.one", "b.two"]);
	});

	it("detects a self-cycle", () => {
		const receipt = compose([
			pattern({ id: "a.self", provides: ["cap.a"], requires: ["cap.a"] }),
		]);
		expect(receipt.reasonCode).toBe("cycle");
		expect(receipt.unsatisfied).toEqual(["a.self"]);
	});

	it("detects a longer cycle", () => {
		const receipt = compose([
			pattern({ id: "a.one", provides: ["cap.a"], requires: ["cap.c"] }),
			pattern({ id: "b.two", provides: ["cap.b"], requires: ["cap.a"] }),
			pattern({ id: "c.three", provides: ["cap.c"], requires: ["cap.b"] }),
		]);
		expect(receipt.reasonCode).toBe("cycle");
		expect(receipt.unsatisfied).toHaveLength(3);
	});

	it("places what it can before reporting the cycle", () => {
		const receipt = compose([
			pattern({ id: "a.free", provides: ["cap.free"] }),
			pattern({ id: "b.one", provides: ["cap.b"], requires: ["cap.c"] }),
			pattern({ id: "c.two", provides: ["cap.c"], requires: ["cap.b"] }),
		]);
		expect(receipt.reasonCode).toBe("cycle");
		expect([...receipt.unsatisfied].sort()).toEqual(["b.one", "c.two"]);
	});
});

describe("acceptance and ordering", () => {
	it("accepts an independent set and reports a digest", () => {
		const receipt = compose([
			pattern({ id: "a.one" }),
			pattern({ id: "b.two" }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.ACCEPTED);
		expect(receipt.decision).toBe(SearchDecision.SELECTED);
		expect(receipt.reasonCode).toBe("covered");
		expect(receipt.outputDigest).toMatch(/^[a-f0-9]{64}$/u);
		expect(receipt.unsatisfied).toEqual([]);
		expect(receipt.conflicts).toEqual([]);
	});

	it("orders a provider before its consumer", () => {
		const receipt = compose([
			pattern({ id: "b.consumer", requires: ["cap.store"] }),
			pattern({ id: "a.provider", provides: ["cap.store"] }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.ACCEPTED);
		expect(receipt.chosenIds).toEqual(["a.provider", "b.consumer"]);
	});

	it("orders a three-link chain", () => {
		const receipt = compose([
			pattern({ id: "c.last", requires: ["cap.b"] }),
			pattern({ id: "a.first", provides: ["cap.a"] }),
			pattern({ id: "b.middle", provides: ["cap.b"], requires: ["cap.a"] }),
		]);
		expect(receipt.chosenIds).toEqual(["a.first", "b.middle", "c.last"]);
	});

	it("emits effects in dependency order", () => {
		const receipt = compose([
			pattern({ id: "b.consumer", requires: ["cap.store"], effects: ["e.b"] }),
			pattern({ id: "a.provider", provides: ["cap.store"], effects: ["e.a"] }),
		]);
		expect(receipt.effectOrder).toEqual(["e.a", "e.b"]);
	});

	it("emits every effect of a pattern that declares several", () => {
		const receipt = compose([
			pattern({ id: "a.one", effects: ["e.1", "e.2"] }),
		]);
		expect(receipt.effectOrder).toEqual(["e.1", "e.2"]);
	});

	it("emits no effects when no chosen pattern declares one", () => {
		expect(compose([pattern({ id: "a.one" })]).effectOrder).toEqual([]);
	});

	it("is deterministic: the same input composes to the same digest", () => {
		const patterns = () => [
			pattern({ id: "b.consumer", requires: ["cap.store"] }),
			pattern({ id: "a.provider", provides: ["cap.store"] }),
		];
		expect(compose(patterns()).outputDigest).toBe(
			compose(patterns()).outputDigest,
		);
	});

	it("produces a different digest for different rendered bodies", () => {
		const first = compose([pattern({ id: "a.one", body: "# first\n" })]);
		const second = compose([pattern({ id: "a.one", body: "# second\n" })]);
		expect(first.outputDigest).not.toBe(second.outputDigest);
	});

	it("produces a different digest when the order differs", () => {
		const forward = compose([
			pattern({ id: "a.one", body: "A\n", provides: ["cap.x"] }),
			pattern({ id: "b.two", body: "B\n", requires: ["cap.x"] }),
		]);
		const reverse = compose([
			pattern({ id: "a.one", body: "A\n", requires: ["cap.x"] }),
			pattern({ id: "b.two", body: "B\n", provides: ["cap.x"] }),
		]);
		expect(forward.chosenIds).toEqual(["a.one", "b.two"]);
		expect(reverse.chosenIds).toEqual(["b.two", "a.one"]);
		expect(forward.outputDigest).not.toBe(reverse.outputDigest);
	});

	it("reports zero LLM usage on acceptance too", () => {
		const receipt = compose([pattern({ id: "a.one" })]);
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
	});

	it("carries no rejected ids", () => {
		expect(compose([pattern({ id: "a.one" })]).rejectedIds).toEqual([]);
		expect(
			compose([
				pattern({ id: "a.one", conflicts: ["b.two"] }),
				pattern({ id: "b.two" }),
			]).rejectedIds,
		).toEqual([]);
	});

	it("carries no requested features", () => {
		expect(compose([pattern({ id: "a.one" })]).requestedFeatures).toEqual([]);
	});
});

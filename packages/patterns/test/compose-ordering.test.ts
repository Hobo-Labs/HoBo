/**
 * `composePatterns` — the requires/provides dependency resolution.
 *
 * Composition selects a set of patterns for a query and then has to answer two
 * questions before emitting anything: *can* these patterns coexist, and in what
 * order do their effects run. Both have a silent failure mode.
 *
 * The topological sort must terminate. A requires/provides cycle has no valid
 * order at all, and a loop that kept looking for a satisfiable next pattern
 * would spin rather than report — so the receipt says `cycle` and names the
 * patterns still unplaced.
 *
 * The refusals must be distinguishable. "These patterns conflict", "something
 * they need is missing", and "the graph has a loop" send an author to three
 * different fixes, so each gets its own `reasonCode` on an otherwise identical
 * REJECTED receipt. A composition that collapsed them into one generic failure
 * would be technically correct and practically useless.
 *
 * Selection is driven here by giving every synthetic pattern the same alias and
 * querying it: `searchPatterns` marks an exact-alias match selectable, which
 * lets these cases control the candidate set exactly rather than depending on
 * how the retrieval scorer happens to rank invented text.
 */
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

/**
 * Synthetic catalogs are backed by a real temp tree, because
 * `readRenderingBody` resolves a rendering's `sourcePath` from disk relative to
 * the `pattern.json` that declares it — an inline body is not a supported
 * shape. Writing the tree keeps these cases exercising the real render path
 * rather than a stub of it.
 */
const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A synthetic pattern that retrieval will mark selectable for `ALIAS`.
 */
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

/** Bodies keyed by pattern id, written into the temp tree by `catalogOf`. */
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
		// The empty-selection branch. An accepted receipt over zero patterns
		// would read downstream as "composed successfully, produced nothing".
		const receipt = compose([], "nothing matches this");
		expect(receipt.status).toBe(ReceiptStatus.REJECTED);
		expect(receipt.decision).toBe(SearchDecision.INCOMPATIBLE);
		expect(receipt.reasonCode).toBe("unsatisfied");
		expect(receipt.chosenIds).toEqual([]);
		expect(receipt.outputDigest).toBe("");
		expect(receipt.effectOrder).toEqual([]);
	});

	it("rejects with reasonCode unsatisfied when a requirement is provided by nobody", () => {
		// The requirement is dropped, not quietly ignored. A pattern that needs
		// an event store and got none would otherwise be rendered as though its
		// dependency were satisfied, and the gap would surface at runtime.
		const receipt = compose([
			pattern({ id: "a.needs", requires: ["cap.store"] }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.REJECTED);
		expect(receipt.reasonCode).toBe("unsatisfied");
		expect(receipt.unsatisfied).toEqual(["cap.store"]);
	});

	it("names every unsatisfied requirement, not just the first", () => {
		// An author fixing them one at a time because the receipt reported one
		// at a time would need as many rounds as there are gaps.
		const receipt = compose([
			pattern({ id: "a.needs", requires: ["cap.one", "cap.two"] }),
		]);
		expect(receipt.unsatisfied).toEqual(["cap.one", "cap.two"]);
	});

	it("treats a requirement satisfied by any chosen pattern as satisfied", () => {
		// Provides are pooled across the whole selection rather than checked
		// pairwise, so order of declaration does not matter.
		const receipt = compose([
			pattern({ id: "a.provider", provides: ["cap.store"] }),
			pattern({ id: "b.consumer", requires: ["cap.store"] }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.ACCEPTED);
		expect(receipt.unsatisfied).toEqual([]);
	});

	it("rejects with reasonCode conflict when two chosen patterns conflict", () => {
		// Conflict wins over unsatisfied in the reason, because a conflict is a
		// choice the author has to make while an unsatisfied requirement is
		// usually something to add.
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
		// Conflicts are filtered against the chosen set. A pattern that declares
		// it cannot coexist with something absent from this composition has no
		// conflict here, and refusing anyway would make every broadly-declared
		// conflict list unusable.
		const receipt = compose([
			pattern({ id: "a.one", conflicts: ["z.not-selected"] }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.ACCEPTED);
		expect(receipt.conflicts).toEqual([]);
	});

	it("still lists the chosen ids on a rejection", () => {
		// So an author can see *what* was selected before the check failed;
		// a rejection with an empty chosen list would leave them guessing which
		// patterns the query matched.
		const receipt = compose([
			pattern({ id: "a.one", conflicts: ["b.two"] }),
			pattern({ id: "b.two" }),
		]);
		expect(receipt.chosenIds).toEqual(["a.one", "b.two"]);
	});

	it("reports zero LLM usage on every rejection", () => {
		// Composition is deterministic and calls no model. A non-zero counter
		// would be a sign something started reaching out.
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
		// The termination guarantee. Each pattern's requirement is provided by
		// the other, so neither can ever be placed first — a loop that kept
		// searching for a satisfiable next pattern would never exit.
		const receipt = compose([
			pattern({ id: "a.one", provides: ["cap.a"], requires: ["cap.b"] }),
			pattern({ id: "b.two", provides: ["cap.b"], requires: ["cap.a"] }),
		]);
		expect(receipt.status).toBe(ReceiptStatus.REJECTED);
		expect(receipt.reasonCode).toBe("cycle");
		expect(receipt.conflicts).toEqual(["cycle"]);
	});

	it("names the patterns it could not place", () => {
		// `unsatisfied` carries the *remaining* pattern ids on the cycle path,
		// which is what tells an author where the loop is — the requirement
		// names alone would not, since each one is satisfiable in isolation.
		const receipt = compose([
			pattern({ id: "a.one", provides: ["cap.a"], requires: ["cap.b"] }),
			pattern({ id: "b.two", provides: ["cap.b"], requires: ["cap.a"] }),
		]);
		expect([...receipt.unsatisfied].sort()).toEqual(["a.one", "b.two"]);
	});

	it("detects a self-cycle", () => {
		// A pattern requiring what it provides cannot be placed, because the
		// requirement is checked against what is *already ordered* — not against
		// the pattern's own provides.
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
		// A satisfiable pattern is ordered first and only the cycle members
		// remain unplaced, so the report points at the actual loop rather than
		// at every pattern in the composition.
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
		// The point of the sort. Effects run in `effectOrder`, so a consumer
		// placed first would run against a capability that does not exist yet.
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
		// `effectOrder` is flattened from the sorted patterns, so it inherits
		// the ordering rather than the authoring order of the catalog.
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
		// The digest is over the rendered bodies in order, so it changes if
		// either the bodies or the ordering change. Two runs over identical
		// input must not differ, or a receipt could not be compared across runs.
		const patterns = () => [
			pattern({ id: "b.consumer", requires: ["cap.store"] }),
			pattern({ id: "a.provider", provides: ["cap.store"] }),
		];
		expect(compose(patterns()).outputDigest).toBe(
			compose(patterns()).outputDigest,
		);
	});

	it("produces a different digest for different rendered bodies", () => {
		// Otherwise the digest would attest to the selection alone and two
		// compositions that rendered different content would look identical.
		const first = compose([pattern({ id: "a.one", body: "# first\n" })]);
		const second = compose([pattern({ id: "a.one", body: "# second\n" })]);
		expect(first.outputDigest).not.toBe(second.outputDigest);
	});

	it("produces a different digest when the order differs", () => {
		// The bodies are joined in sorted order before hashing, so a dependency
		// edge that reversed the order changes the digest — which is what makes
		// the digest a witness to the ordering and not only to the set.
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
		// Pinned as a known gap rather than as an intent: `rejectedIds` is
		// hard-coded empty on every path, so a receipt cannot say which
		// candidates the search considered and dropped. Flagged for whoever owns
		// the composition receipt shape — the field exists on the wire and is
		// never populated.
		expect(compose([pattern({ id: "a.one" })]).rejectedIds).toEqual([]);
		expect(
			compose([
				pattern({ id: "a.one", conflicts: ["b.two"] }),
				pattern({ id: "b.two" }),
			]).rejectedIds,
		).toEqual([]);
	});

	it("carries no requested features", () => {
		// Same shape of gap: `requestedFeatures` is always empty, so the receipt
		// does not record what the query asked for. Recorded here so a later
		// change to populate it is deliberate.
		expect(compose([pattern({ id: "a.one" })]).requestedFeatures).toEqual([]);
	});
});

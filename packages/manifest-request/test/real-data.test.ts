/**
 * Do the closed vocabularies admit the values the repository actually emits?
 *
 * A closed enum is a bet that nothing outside it occurs. The recipe goldens
 * are the widest real sample of claim and realization vocabulary in the tree —
 * committed outputs that other packages assert against byte-for-byte — so they
 * are where that bet gets settled. The scan asserts a non-empty corpus first:
 * a coverage test over an empty sample passes without checking anything, which
 * is the failure mode this file exists to avoid.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	CLAIM_ATOMICITIES,
	CREATOR_AUTHORITIES_AFTER_CLAIM,
	REALIZATION_KINDS,
} from "../src/index.js";
import { REPO_ROOT, readRepoFile } from "./fixtures.js";

const GOLDEN_DIR = join(REPO_ROOT, "packages", "recipes", "test", "golden");

const WATCHED = {
	realization: REALIZATION_KINDS,
	creatorAuthorityAfterClaim: CREATOR_AUTHORITIES_AFTER_CLAIM,
	atomicity: CLAIM_ATOMICITIES,
} as const;

type Watched = keyof typeof WATCHED;

function collect(): Record<Watched, ReadonlySet<string>> {
	const found: Record<Watched, Set<string>> = {
		realization: new Set(),
		creatorAuthorityAfterClaim: new Set(),
		atomicity: new Set(),
	};
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const entry of node) walk(entry);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		for (const [key, value] of Object.entries(node)) {
			if (key in found && typeof value === "string") {
				found[key as Watched].add(value);
			}
			walk(value);
		}
	};
	const files = readdirSync(GOLDEN_DIR)
		.filter((file) => file.endsWith(".json"))
		.sort();
	for (const file of files)
		walk(JSON.parse(readRepoFile(join(GOLDEN_DIR, file))));
	return found;
}

const OBSERVED = collect();

describe("closed vocabularies against committed golden outputs", () => {
	for (const key of Object.keys(WATCHED) as readonly Watched[]) {
		it(`observes ${key} values in the goldens at all`, () => {
			expect([...OBSERVED[key]].sort()).not.toStrictEqual([]);
		});

		it(`admits every ${key} value the goldens carry`, () => {
			const admitted = new Set<string>(WATCHED[key]);
			const rejected = [...OBSERVED[key]].filter(
				(value) => !admitted.has(value),
			);
			expect(rejected).toStrictEqual([]);
		});
	}

	it("sees the full claim-atomicity vocabulary exercised, not just the easy one", () => {
		expect([...OBSERVED.atomicity].sort()).toStrictEqual(
			[...CLAIM_ATOMICITIES].sort(),
		);
	});
});

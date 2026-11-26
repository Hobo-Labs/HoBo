/**
 * Characterization (approval / snapshot) tests for the competitor-corpus
 * generators.
 *
 * Why these exist separately from `competitor-docs.test.ts`: that file asserts
 * *rules* ("an unknown category is rejected"). These assert *output* — the
 * exact markdown three generators emit. Those generators write files that are
 * committed to the repo and read by humans, and until now nothing pinned their
 * shape: a change to a column, a separator, a sort order or a pluralization
 * would have sailed through every existing test and landed silently in 90
 * documents.
 *
 * `toMatchFileSnapshot` is the repo's Verify/ApprovalTests equivalent: the
 * approved output lives in a committed file under `__snapshots__/`, reviewed
 * as part of the diff, and updated deliberately with `vitest -u`. Inline
 * snapshots were rejected for this because the approved artifact *is* markdown
 * — reviewing it as markdown in its own file is the entire point.
 *
 * The corpus here is a fixed synthetic fixture, never the live one. Snapshotting
 * the real corpus would repaint these files on every capture added and train
 * everyone to run `-u` without reading, which is how approval testing dies.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import {
	type Competitor,
	renderCategoryIndex,
	renderIndex,
	renderMatrix,
	staleCaptures,
} from "../scripts/check-competitor-docs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshot = (name: string) =>
	path.join(here, "__snapshots__", `${name}.md`);

/**
 * A fixed instant for the staleness report, which is the one output here that
 * reads a clock. Chosen to sit a known distance from the fixture dates below:
 * two captures are inside the 180-day window, one is well outside it.
 */
const NOW = Date.parse("2026-06-01T00:00:00Z");

function competitor(overrides: Partial<Competitor> = {}): Competitor {
	return {
		slug: "acme",
		name: "Acme",
		aliases: [],
		primary_category: "infrastructure-from-code",
		categories: ["infrastructure-from-code"],
		directness: "direct",
		role: "authoring analog",
		posture: ["borrow"],
		hobo_surface: ["authoring"],
		evidence: "design-only",
		status: "active",
		research_date: "2026-05-01",
		sources: ["https://acme.example/docs"],
		contract: "v1",
		file: "docs/competitors/acme.md",
		...overrides,
	};
}

/**
 * Deliberately exercises the branches that vary the output: an alias list vs
 * none, multi-category membership, a pre-v1 capture, a stale capture, a renamed
 * product, and a name whose case differs from its slug (the index sorts on
 * lowercased name, which is only observable with mixed case present).
 */
const CORPUS: Competitor[] = [
	competitor(),
	competitor({
		slug: "zebra",
		name: "zebra systems",
		aliases: ["zed", "zebra.io"],
		primary_category: "runtime-substrates",
		categories: ["runtime-substrates", "infrastructure-from-code"],
		directness: "overlapping",
		posture: ["provider-target", "benchmark"],
		hobo_surface: ["runtime-portability", "governance"],
		evidence: "implemented",
		research_date: "2026-05-20",
		file: "docs/competitors/zebra.md",
	}),
	competitor({
		slug: "legacy-corp",
		name: "Legacy Corp",
		aliases: ["oldname"],
		primary_category: "self-hosted-paas",
		categories: ["self-hosted-paas"],
		directness: "adjacent",
		posture: ["benchmark"],
		hobo_surface: ["delivery"],
		evidence: "not-present",
		status: "renamed",
		// Older than STALE_AFTER_DAYS relative to NOW: the one stale capture.
		research_date: "2025-01-15",
		contract: undefined,
		file: "docs/competitors/legacy-corp.md",
	}),
];

test("the cross-category matrix and freshness ledger render as approved", async () => {
	await expect(renderMatrix(CORPUS)).toMatchFileSnapshot(
		snapshot("competitor-matrix"),
	);
});

test("the corpus index renders as approved", async () => {
	await expect(renderIndex(CORPUS)).toMatchFileSnapshot(
		snapshot("competitor-index"),
	);
});

test("the category index renders as approved", async () => {
	await expect(renderCategoryIndex(CORPUS)).toMatchFileSnapshot(
		snapshot("category-index"),
	);
});

test("an empty corpus still renders every closed-vocabulary category", async () => {
	await expect(renderCategoryIndex([])).toMatchFileSnapshot(
		snapshot("category-index-empty"),
	);
});

/**
 * The regression this pins: the ledger printed each capture's age, so this
 * function's output — and the committed `matrix.md` — changed every single day
 * and `lint:docs` failed until someone regenerated it. `renderMatrix` takes no
 * clock; what a clock decides lives in `staleCaptures`.
 */
test("the matrix is a pure function of the corpus", () => {
	expect(renderMatrix(CORPUS)).toBe(renderMatrix(CORPUS));
	expect(renderMatrix.length).toBe(1);
	expect(renderMatrix(CORPUS)).not.toMatch(/Age \(days\)|stale — refresh/);
});

test("staleCaptures lists what the clock says is past 180 days, oldest first", () => {
	expect(staleCaptures(CORPUS, NOW)).toEqual([
		{
			slug: "legacy-corp",
			name: "Legacy Corp",
			research_date: "2025-01-15",
			age: 502,
		},
	]);
	// The same corpus on a later clock: the 2026-05-01 capture joins, behind it.
	const later = staleCaptures(CORPUS, NOW + 400 * 86_400_000);
	expect(later.map((row) => row.slug)).toEqual([
		"legacy-corp",
		"acme",
		"zebra",
	]);
	expect(staleCaptures(CORPUS, Date.parse("2025-01-01T00:00:00Z"))).toEqual([]);
});

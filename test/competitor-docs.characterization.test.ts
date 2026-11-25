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
	const later = staleCaptures(CORPUS, NOW + 400 * 86_400_000);
	expect(later.map((row) => row.slug)).toEqual([
		"legacy-corp",
		"acme",
		"zebra",
	]);
	expect(staleCaptures(CORPUS, Date.parse("2025-01-01T00:00:00Z"))).toEqual([]);
});

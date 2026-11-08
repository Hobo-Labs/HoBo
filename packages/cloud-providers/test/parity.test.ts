/**
 * Parity taxonomy: every per-provider claim is recounted from code.
 *
 * The reason this file exists is that the resolver counts had drifted in three
 * places at once — this package's header said `aws (7/19)`, `src/aws.ts` said
 * AWS "ships no deployment resolvers", and the README said Hostinger resolved
 * 2 of 5 — while the constants in the provider packages said 8, some, and 5.
 * Each prose number was right once. None of them was checked.
 *
 * So the assertions here never restate a count. Expected denominators are
 * computed from the same two live sources `providerParity()` reads — the
 * namespace's `Yard()` catalog and the provider package's exported
 * `*_RESOLVED_PRODUCT_IDS` constant — so the test fails when the projection
 * disagrees with the code, not when someone forgets to bump a literal.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AWS_RESOLVED_PRODUCT_IDS } from "@hobo/provider-aws";
import { AZURE_RESOLVED_PRODUCT_IDS } from "@hobo/provider-azure";
import { CLOUDFLARE_RESOLVED_PRODUCT_IDS } from "@hobo/provider-cloudflare";
import { DIGITALOCEAN_RESOLVED_PRODUCT_IDS } from "@hobo/provider-digitalocean";
import { GCP_RESOLVED_PRODUCT_IDS } from "@hobo/provider-gcp";
import { HETZNER_RESOLVED_PRODUCT_IDS } from "@hobo/provider-hetzner";
import { HOSTINGER_RESOLVED_PRODUCT_IDS } from "@hobo/provider-hostinger";
import { KUBERNETES_RESOLVED_PRODUCT_IDS } from "@hobo/provider-kubernetes";
import { VERCEL_RESOLVED_PRODUCT_IDS } from "@hobo/provider-vercel";
import { describe, expect, it } from "vitest";

import {
	aws,
	azure,
	cloudflare,
	digitalocean,
	formatParityClaim,
	gcp,
	hetzner,
	hostinger,
	kubernetes,
	PARITY_LEVELS,
	PARITY_PROVIDERS,
	ParityError,
	parityRow,
	providerParity,
	vercel,
} from "../src/index.js";

/** Live sources, keyed the way `providerParity()` keys its rows. */
const LIVE = {
	aws: { yard: () => aws.Yard(), resolved: AWS_RESOLVED_PRODUCT_IDS },
	azure: { yard: () => azure.Yard(), resolved: AZURE_RESOLVED_PRODUCT_IDS },
	cloudflare: {
		yard: () => cloudflare.Yard(),
		resolved: CLOUDFLARE_RESOLVED_PRODUCT_IDS,
	},
	digitalocean: {
		yard: () => digitalocean.Yard(),
		resolved: DIGITALOCEAN_RESOLVED_PRODUCT_IDS,
	},
	gcp: { yard: () => gcp.Yard(), resolved: GCP_RESOLVED_PRODUCT_IDS },
	hetzner: {
		yard: () => hetzner.Yard(),
		resolved: HETZNER_RESOLVED_PRODUCT_IDS,
	},
	hostinger: {
		yard: () => hostinger.Yard(),
		resolved: HOSTINGER_RESOLVED_PRODUCT_IDS,
	},
	kubernetes: {
		yard: () => kubernetes.Yard(),
		resolved: KUBERNETES_RESOLVED_PRODUCT_IDS,
	},
	// `project()` is an opt-in row: the bare default omits it, but it is an
	// allocatable Vercel offering and it has a resolver. See src/parity.ts.
	vercel: {
		yard: () => vercel.Yard({ project: {} }),
		resolved: VERCEL_RESOLVED_PRODUCT_IDS,
	},
} as const;

function catalogIdsOf(yard: {
	readonly bindings: readonly { readonly productId?: string }[];
}): string[] {
	const ids = new Set<string>();
	for (const binding of yard.bindings) {
		if (binding.productId !== undefined) ids.add(binding.productId);
	}
	return [...ids].sort();
}

describe("providerParity()", () => {
	const rows = providerParity();

	it("covers every namespace exactly once, in provider order", () => {
		expect(rows.map((row) => row.provider)).toEqual([...PARITY_PROVIDERS]);
		expect([...PARITY_PROVIDERS].sort()).toEqual(Object.keys(LIVE).sort());
	});

	for (const [provider, live] of Object.entries(LIVE)) {
		it(`${provider}: denominator is recounted from the live constants`, () => {
			const row = rows.find((candidate) => candidate.provider === provider);
			expect(row).toBeDefined();
			const catalog = catalogIdsOf(live.yard());
			const resolved = [...live.resolved].sort();
			expect(row?.catalogProductIds).toEqual(catalog);
			expect(row?.resolvedProductIds).toEqual(resolved);
			expect(row?.denominator).toBe(`${resolved.length}/${catalog.length}`);
			expect(row?.level).toBe(resolved.length > 0 ? "L1" : "P0");
		});
	}

	it("emits nothing above L1 — higher levels need executed evidence", () => {
		for (const row of rows) expect(["P0", "L1"]).toContain(row.level);
	});

	it("is deterministic and deep-frozen", () => {
		expect(providerParity()).toEqual(rows);
		expect(Object.isFrozen(rows)).toBe(true);
		for (const row of rows) {
			expect(Object.isFrozen(row)).toBe(true);
			expect(Object.isFrozen(row.catalogProductIds)).toBe(true);
			expect(Object.isFrozen(row.resolvedProductIds)).toBe(true);
		}
	});

	it("renders the parity table from code", () => {
		const table = rows.map(formatParityClaim).join("\n");
		// Printed so a reviewer sees the projection, not just a green tick.
		console.log(`\n${table}\n`);
		expect(table.split("\n")).toHaveLength(PARITY_PROVIDERS.length);
	});
});

describe("parityRow() level rules", () => {
	it("resolved > 0 on fake transport is L1 — never higher", () => {
		const row = parityRow("acme", ["acme.a/v1", "acme.b/v1"], ["acme.a/v1"]);
		expect(row.level).toBe("L1");
		expect(row.denominator).toBe("1/2");
	});

	it("resolved == 0 is P0 (catalog only)", () => {
		const row = parityRow("acme", ["acme.a/v1"], []);
		expect(row.level).toBe("P0");
		expect(row.denominator).toBe("0/1");
	});

	it("canonicalizes input order and duplicates", () => {
		const a = parityRow("acme", ["acme.b/v1", "acme.a/v1"], ["acme.b/v1"]);
		const b = parityRow(
			"acme",
			["acme.a/v1", "acme.b/v1", "acme.a/v1"],
			["acme.b/v1", "acme.b/v1"],
		);
		expect(a).toEqual(b);
		expect(a.catalogProductIds).toEqual(["acme.a/v1", "acme.b/v1"]);
	});

	it("refuses a resolved id the catalog does not declare", () => {
		let caught: unknown;
		try {
			parityRow("acme", ["acme.a/v1"], ["acme.ghost/v1"]);
		} catch (error) {
			caught = error;
		}
		if (!(caught instanceof ParityError)) {
			throw new Error("expected a ParityError");
		}
		expect(caught.code).toBe("PARITY_RESOLVED_NOT_IN_CATALOG");
		expect(caught.message).toContain("acme.ghost/v1");
	});

	it("refuses an empty provider id", () => {
		expect(() => parityRow("", ["acme.a/v1"], [])).toThrow(ParityError);
	});
});

describe("formatParityClaim()", () => {
	it("always carries the denominator and the evidence kind", () => {
		expect(
			formatParityClaim(parityRow("aws", ["a/v1", "b/v1", "c/v1"], ["a/v1"])),
		).toBe("aws L1: 1/3 simulated (fake-transport)");
		expect(formatParityClaim(parityRow("acme", ["a/v1"], []))).toBe(
			"acme P0: 0/1 catalog only",
		);
	});
});

describe("PARITY_LEVELS", () => {
	it("is the closed council vocabulary, in ascending local-then-cloud order", () => {
		expect([...PARITY_LEVELS]).toEqual(["P0", "L1", "L2", "L3", "P2", "P3"]);
	});

	it("matches the CUE closed set", () => {
		const cue = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"..",
				"data-models",
				"provider_catalog.cue",
			),
			"utf8",
		);
		const line = /#ParityLevel:\s*(.+)/u.exec(cue)?.[1] ?? "";
		const levels = [...line.matchAll(/"([A-Z0-9]+)"/gu)].map((m) => m[1]);
		expect(levels).toEqual([...PARITY_LEVELS]);
	});
});

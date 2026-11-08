/**
 * Parity taxonomy: every per-provider claim is recounted from code.
 *
 * The reason this file exists is that the resolver counts had drifted in three
 * places at once — this package's header said `aws (7/19)`, `src/aws.ts` said
 * AWS "ships no deployment resolvers", and the README said Hostinger resolved
 * 2 of 5 — while the constants in the provider packages said 8, some, and 5.
 * Each prose number was right once. None of them was checked.
 *
 * So the assertions here restate no count except Vercel's 3/5, which pins why
 * its catalog is widened. The catalog side is read through the exported
 * `PARITY_SOURCES` (no hand twin of its Yard calls); the resolved side is
 * imported straight from each provider package's `*_RESOLVED_PRODUCT_IDS`, so
 * a source wired to the wrong constant fails.
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

import * as namespaces from "../src/index.js";
import {
	formatParityClaim,
	PARITY_LEVELS,
	PARITY_PROVIDERS,
	PARITY_SOURCES,
	ParityError,
	parityRow,
	providerParity,
	toProviderParityRecord,
	vercel,
} from "../src/index.js";

/**
 * The resolved side, imported straight from each provider package — not read
 * back through `PARITY_SOURCES` — so a source wired to the wrong constant fails.
 */
const RESOLVED_CONSTANTS = {
	aws: AWS_RESOLVED_PRODUCT_IDS,
	azure: AZURE_RESOLVED_PRODUCT_IDS,
	cloudflare: CLOUDFLARE_RESOLVED_PRODUCT_IDS,
	digitalocean: DIGITALOCEAN_RESOLVED_PRODUCT_IDS,
	gcp: GCP_RESOLVED_PRODUCT_IDS,
	hetzner: HETZNER_RESOLVED_PRODUCT_IDS,
	hostinger: HOSTINGER_RESOLVED_PRODUCT_IDS,
	kubernetes: KUBERNETES_RESOLVED_PRODUCT_IDS,
	vercel: VERCEL_RESOLVED_PRODUCT_IDS,
} as const;

const here = dirname(fileURLToPath(import.meta.url));
const readPackageFile = (...path: string[]) =>
	readFileSync(join(here, "..", ...path), "utf8");

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
		expect(Object.keys(PARITY_SOURCES).sort()).toEqual(
			[...PARITY_PROVIDERS].sort(),
		);
		expect(Object.keys(RESOLVED_CONSTANTS).sort()).toEqual(
			[...PARITY_PROVIDERS].sort(),
		);
	});

	for (const provider of PARITY_PROVIDERS) {
		it(`${provider}: denominator is recounted from the live constants`, () => {
			const row = rows.find((candidate) => candidate.provider === provider);
			expect(row).toBeDefined();
			const catalog = catalogIdsOf(PARITY_SOURCES[provider].catalog());
			const resolved = [...new Set(RESOLVED_CONSTANTS[provider])].sort();
			expect(PARITY_SOURCES[provider].resolved).toBe(
				RESOLVED_CONSTANTS[provider],
			);
			expect(row?.catalogProductIds).toEqual(catalog);
			expect(row?.resolvedProductIds).toEqual(resolved);
			expect(row?.denominator).toBe(`${resolved.length}/${catalog.length}`);
		});
	}

	it("measures every namespace but vercel against its bare Yard()", () => {
		for (const provider of PARITY_PROVIDERS) {
			if (provider === "vercel") continue;
			expect(catalogIdsOf(PARITY_SOURCES[provider].catalog())).toEqual(
				catalogIdsOf(namespaces[provider].Yard()),
			);
		}
	});

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

	it("matches the README's parity block byte for byte", () => {
		const block =
			/<!-- parity:begin -->\n```text\n([\s\S]*?)\n```\n<!-- parity:end -->/u.exec(
				readPackageFile("README.md"),
			);
		expect(block?.[1]).toBe(rows.map(formatParityClaim).join("\n"));
	});
});

describe("vercel's widened catalog", () => {
	it("bare Yard() cannot be the denominator: its resolved ids are not all declared", () => {
		let caught: unknown;
		try {
			parityRow(
				"vercel",
				catalogIdsOf(vercel.Yard()),
				VERCEL_RESOLVED_PRODUCT_IDS,
			);
		} catch (error) {
			caught = error;
		}
		if (!(caught instanceof ParityError)) {
			throw new Error("expected a ParityError");
		}
		expect(caught.code).toBe("PARITY_RESOLVED_NOT_IN_CATALOG");
		expect(caught.message).toContain("vercel.project/v1");
	});

	it("default is four offerings; full catalog adds project() for five", () => {
		expect(catalogIdsOf(vercel.Yard())).toHaveLength(4);
		const full = catalogIdsOf(vercel.Yard({ project: {} }));
		expect(full).toHaveLength(5);
		expect(full).toContain("vercel.project/v1");
	});

	it("providerParity() reports vercel as 3/5", () => {
		const row = providerParity().find((r) => r.provider === "vercel");
		expect(row?.denominator).toBe("3/5");
	});
});

describe("toProviderParityRecord()", () => {
	const rows = providerParity();

	it("encodes every providerParity() row consistently", () => {
		for (const row of rows) {
			const record = toProviderParityRecord(row);
			expect(record).toEqual({
				provider: row.provider,
				level: row.level,
				catalog_count: row.catalogProductIds.length,
				resolved_count: row.resolvedProductIds.length,
				denominator: `${row.resolvedProductIds.length}/${row.catalogProductIds.length}`,
			});
			expect(record.denominator).toBe(row.denominator);
			// The CUE record's invariants, checked on the real rows.
			expect(record.resolved_count).toBeLessThanOrEqual(record.catalog_count);
			expect(record.level === "P0").toBe(record.resolved_count === 0);
			expect(Object.isFrozen(record)).toBe(true);
		}
	});

	it("has exactly the proto message's fields", () => {
		const proto = readPackageFile("data-models", "provider_catalog.proto");
		const body =
			/message ProviderParityRowRecord \{([^}]*)\}/u.exec(proto)?.[1] ?? "";
		const fields = [...body.matchAll(/\b([a-z_]+) = \d+;/gu)].map((m) => m[1]);
		const [first] = rows;
		if (first === undefined) throw new Error("no rows");
		expect(Object.keys(toProviderParityRecord(first)).sort()).toEqual(
			[...fields].sort(),
		);
	});
});

describe("parityRow() level rules", () => {
	it("resolved > 0 is L1 (candidate) — never higher", () => {
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
		).toBe("aws L1: 1/3 resolvers declared (conformance not asserted here)");
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
		const cue = readPackageFile("data-models", "provider_catalog.cue");
		const line = /#ParityLevel:\s*(.+)/u.exec(cue)?.[1] ?? "";
		const levels = [...line.matchAll(/"([A-Z0-9]+)"/gu)].map((m) => m[1]);
		expect(levels).toEqual([...PARITY_LEVELS]);
	});
});

describe("#ProviderParityRowRecord (CUE)", () => {
	const cue = readPackageFile("data-models", "provider_catalog.cue");
	const block =
		/^#ProviderParityRowRecord: \{\n([\s\S]*?)^\}/mu.exec(cue)?.[1] ?? "";

	it("caps level at the constants-only set {P0, L1}", () => {
		const constants =
			/^#ConstantsParityLevel:\s*#ParityLevel & \(([^)]*)\)/mu.exec(cue)?.[1] ??
			"";
		expect([...constants.matchAll(/"([A-Z0-9]+)"/gu)].map((m) => m[1])).toEqual(
			["P0", "L1"],
		);
		expect(block).toMatch(/^\s*level:\s*#ConstantsParityLevel\s*$/mu);
	});

	it("forces P0 iff resolved_count == 0, both directions", () => {
		expect(block).toMatch(
			/if resolved_count == 0 \{\s*level: "P0"\s*\}/u,
		);
		expect(block).toMatch(/if resolved_count > 0 \{\s*level: "L1"\s*\}/u);
	});

	it("bounds the counts and derives the denominator", () => {
		expect(block).toMatch(/resolved_count:\s*int & >=0 & <=catalog_count/u);
		expect(block).toMatch(/catalog_count:\s*int & >=0/u);
		expect(block).toContain(
			'denominator: "\\(resolved_count)/\\(catalog_count)"',
		);
	});
});

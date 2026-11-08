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
	providerProfileParity,
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

function catchParityError(run: () => void): ParityError {
	try {
		run();
	} catch (error) {
		if (error instanceof ParityError) return error;
		throw error;
	}
	throw new Error("expected a ParityError");
}

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

	it("emits only P0 or L1-DECLARED — higher levels need executed evidence", () => {
		for (const row of rows) expect(["P0", "L1-DECLARED"]).toContain(row.level);
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

describe("providerProfileParity()", () => {
	const rows = providerProfileParity();

	it("derives every profile's catalog and resolved subset in deterministic order", () => {
		const expected = PARITY_PROVIDERS.flatMap((provider) => {
			const source = PARITY_SOURCES[provider];
			const byProfile = new Map<string, string[]>();
			for (const binding of source.catalog().bindings) {
				if (binding.productId === undefined) continue;
				const ids = byProfile.get(binding.profile) ?? [];
				ids.push(binding.productId);
				byProfile.set(binding.profile, ids);
			}
			return [...byProfile.keys()].sort().map((profile) => {
				const catalog = [
					...new Set(byProfile.get(profile) ?? []),
				].sort();
				const declared = new Set(catalog);
				const resolved = [
					...new Set(source.resolved.filter((id) => declared.has(id))),
				].sort();
				return {
					provider,
					profile,
					catalogProductIds: catalog,
					resolvedProductIds: resolved,
					level: resolved.length > 0 ? "L1-DECLARED" : "P0",
					denominator: `${resolved.length}/${catalog.length}`,
				};
			});
		});
		expect(rows).toEqual(expected);
	});

	it("keeps an unresolved AWS profile at P0 while the provider is L1-DECLARED", () => {
		const provider = providerParity().find((row) => row.provider === "aws");
		const profile = rows.find(
			(row) => row.provider === "aws" && row.profile === "data.postgres/v1",
		);
		expect(provider?.level).toBe("L1-DECLARED");
		expect(profile?.level).toBe("P0");
		expect(profile?.denominator).toBe("0/2");
		expect(profile?.resolvedProductIds).toEqual([]);
	});

	it("is deterministic and deep-frozen", () => {
		expect(providerProfileParity()).toEqual(rows);
		expect(Object.isFrozen(rows)).toBe(true);
		for (const row of rows) {
			expect(Object.isFrozen(row)).toBe(true);
			expect(Object.isFrozen(row.catalogProductIds)).toBe(true);
			expect(Object.isFrozen(row.resolvedProductIds)).toBe(true);
		}
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

describe("parityRow() level rules", () => {
	it("resolved > 0 is L1-DECLARED — never full L1 or higher", () => {
		const row = parityRow("acme", ["acme.a/v1", "acme.b/v1"], ["acme.a/v1"]);
		expect(row.level).toBe("L1-DECLARED");
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

	for (const provider of ["", " \t\n"]) {
		it(`refuses blank provider id ${JSON.stringify(provider)}`, () => {
			const error = catchParityError(() =>
				parityRow(provider, ["acme.a/v1"], []),
			);
			expect(error.code).toBe("PARITY_PROVIDER_EMPTY");
		});
	}

	for (const productId of ["", " \t\n"]) {
		it(`refuses blank catalog product id ${JSON.stringify(productId)}`, () => {
			const error = catchParityError(() =>
				parityRow("acme", [productId], []),
			);
			expect(error.code).toBe("PARITY_PRODUCT_ID_EMPTY");
		});

		it(`refuses blank resolved product id ${JSON.stringify(productId)}`, () => {
			const error = catchParityError(() =>
				parityRow("acme", ["acme.a/v1"], [productId]),
			);
			expect(error.code).toBe("PARITY_PRODUCT_ID_EMPTY");
		});
	}

	it("refuses an empty catalog", () => {
		const error = catchParityError(() => parityRow("acme", [], []));
		expect(error.code).toBe("PARITY_CATALOG_EMPTY");
	});
});

describe("formatParityClaim()", () => {
	it("always carries the derived denominator and the evidence kind", () => {
		expect(
			formatParityClaim(parityRow("aws", ["a/v1", "b/v1", "c/v1"], ["a/v1"])),
		).toBe("aws L1-DECLARED: 1/3 resolvers declared (conformance not asserted here)");
		expect(formatParityClaim(parityRow("acme", ["a/v1"], []))).toBe(
			"acme P0: 0/1 catalog only",
		);
	});

	it("re-derives a fabricated row instead of rendering its claims", () => {
		const fabricated = {
			...parityRow("aws", ["a/v1", "b/v1"], ["a/v1"]),
			level: "P0" as const,
			denominator: "9/9",
		};
		expect(formatParityClaim(fabricated)).toBe(
			"aws L1-DECLARED: 1/2 resolvers declared (conformance not asserted here)",
		);
	});
});

describe("PARITY_LEVELS", () => {
	it("is the closed council vocabulary, in ascending local-then-cloud order", () => {
		expect([...PARITY_LEVELS]).toEqual(["P0", "L1", "L2", "L3", "P2", "P3"]);
	});
});

describe("parity read-model boundary", () => {
	it("has no protobuf or CUE record for an in-process projection", () => {
		const proto = readPackageFile("data-models", "provider_catalog.proto");
		const cue = readPackageFile("data-models", "provider_catalog.cue");
		for (const schema of [proto, cue]) {
			expect(schema).not.toContain("ProviderParityRowRecord");
			expect(schema).not.toContain("ConstantsParityLevel");
			expect(schema).not.toContain("#ParityLevel");
		}
	});
});

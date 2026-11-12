/**
 * Invariant I14 (plan 0024 WP14): every package under `packages/providers`
 * resolves to a realization path and a traffic profile, or to a typed refusal.
 *
 * The catalog's `PROVIDER_DELIVERY_COVERAGE` table is checked against the
 * directory listing (no provider can be added without a row), and every row's
 * named exports are loaded from the provider package itself and checked: the
 * resolver export is callable, the traffic profile parses at the core
 * boundary, and a published coverage document agrees with the profile and
 * declares every portable offering present or absent.
 *
 * `@hobo/hobo` does not depend on every provider package, so each module is
 * loaded from its source entry point. Exports a sibling work package adds
 * (plan 0024 WP13: convex, flux, webernetes, railway coverage) are checked as
 * soon as they exist; until then their cases are skipped with that reason.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	BUILTIN_TRAFFIC_ROUTING_PROFILES as CONNECTIVITY_BUILTINS,
	LAKEBED_TRAFFIC_ROUTING_PROFILE as CONNECTIVITY_LAKEBED,
	VERCEL_TRAFFIC_ROUTING_PROFILE as CONNECTIVITY_VERCEL,
} from "@hobo/connectivity";
import {
	parseTrafficRoutingProviderProfile,
	ResolverError,
	type TrafficRoutingProviderProfile,
} from "@hobo/core";
import { LAKEBED_TRAFFIC_ROUTING_PROFILE as LAKEBED_PACKAGE } from "@hobo/provider-lakebed";
import { NETLIFY_TRAFFIC_ROUTING_PROFILE as NETLIFY_PACKAGE } from "@hobo/provider-netlify";
import { VERCEL_TRAFFIC_ROUTING_PROFILE as VERCEL_PACKAGE } from "@hobo/provider-vercel";
import { describe, expect, it } from "vitest";
import {
	PROVIDER_DELIVERY_COVERAGE,
	type ProviderDeliveryCoverage,
	providerDeliveryRefusal,
} from "../src/provider-hosting-catalog.js";

const PROVIDERS_ROOT = fileURLToPath(
	new URL("../../providers/", import.meta.url),
);
const PORTABLE_OFFERINGS = 17;
const COVERAGE_CONTRACT = "hobo.provider-hosting-coverage/v1";
const PENDING_SIBLING =
	"binds when cd/wp13-providers-a merges (plan 0024 WP13 adds this export)";
const WP13_PACKAGES = new Set([
	"@hobo/provider-convex",
	"@hobo/provider-flux",
	"@hobo/provider-webernetes",
	"@hobo/provider-railway",
]);

interface ProviderPackage {
	readonly directory: string;
	readonly name: string;
	readonly entry: string;
	readonly indexText: string;
}

function readPackages(): readonly ProviderPackage[] {
	return readdirSync(PROVIDERS_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(PROVIDERS_ROOT, entry.name))
		.filter((directory) => existsSync(join(directory, "package.json")))
		.map((directory) => {
			// SAFETY: a workspace package.json is a JSON object with a name.
			const manifest = JSON.parse(
				readFileSync(join(directory, "package.json"), "utf8"),
			) as { name: string };
			const entry = join(directory, "src", "index.ts");
			return {
				directory,
				name: manifest.name,
				entry,
				indexText: existsSync(entry) ? readFileSync(entry, "utf8") : "",
			};
		})
		.sort((left, right) => (left.name < right.name ? -1 : 1));
}

const PACKAGES = readPackages();

function packageFor(row: ProviderDeliveryCoverage): ProviderPackage {
	const found = PACKAGES.find((entry) => entry.name === row.packageName);
	if (!found) throw new Error(`no provider package ${row.packageName}`);
	return found;
}

/** Exports a row names, which must appear in the package's public entry point. */
function namedExports(row: ProviderDeliveryCoverage): readonly string[] {
	if (row.realization !== "resolver") return [];
	return [
		row.resolverExport,
		...(row.traffic.kind === "profile" ? [row.traffic.profileExport] : []),
		...(row.coverageExport ? [row.coverageExport] : []),
	];
}

function missingExports(row: ProviderDeliveryCoverage): readonly string[] {
	const text = packageFor(row).indexText;
	return namedExports(row).filter(
		(name) => !new RegExp(`\\b${name}\\b`, "u").test(text),
	);
}

async function load(
	row: ProviderDeliveryCoverage,
): Promise<Record<string, unknown>> {
	// SAFETY: a dynamically imported ES module namespace is a record of exports.
	return (await import(pathToFileURL(packageFor(row).entry).href)) as Record<
		string,
		unknown
	>;
}

function profileIds(profile: TrafficRoutingProviderProfile): string[] {
	return profile.offerings.map((entry) => entry.id);
}

describe("I14: every provider package has a delivery row", () => {
	it("enumerates packages/providers/* and finds exactly one row per package", () => {
		expect(PACKAGES.length).toBeGreaterThan(0);
		const rows = PROVIDER_DELIVERY_COVERAGE.map((row) => row.packageName);
		expect(new Set(rows).size).toBe(rows.length);
		expect([...rows].sort()).toEqual(PACKAGES.map((entry) => entry.name));
	});

	it("keys rows by unique provider ids", () => {
		const ids = PROVIDER_DELIVERY_COVERAGE.map((row) => row.providerId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("only sibling work packages' exports may still be missing", () => {
		for (const row of PROVIDER_DELIVERY_COVERAGE) {
			const missing = missingExports(row);
			if (missing.length > 0)
				expect(WP13_PACKAGES.has(row.packageName), missing.join(", ")).toBe(
					true,
				);
		}
	});
});

describe("I14: realization path plus traffic profile", () => {
	for (const row of PROVIDER_DELIVERY_COVERAGE) {
		if (row.realization !== "resolver") continue;
		const pending = missingExports(row).length > 0;
		it.skipIf(pending)(
			`${row.packageName} exports ${namedExports(row).join(", ")}${pending ? ` (${PENDING_SIBLING})` : ""}`,
			async () => {
				const module = await load(row);
				expect(module[row.resolverExport]).toBeInstanceOf(Function);
				expect(providerDeliveryRefusal(row.packageName)).toBeUndefined();
				expect(providerDeliveryRefusal(row.providerId)).toBeUndefined();
				if (row.traffic.kind === "refused") {
					expect(row.traffic.reason.trim()).not.toBe("");
					expect(row.traffic.remediation.trim()).not.toBe("");
					return;
				}
				// SAFETY: the named export is a TrafficRoutingProviderProfile record.
				const profile = module[
					row.traffic.profileExport
				] as TrafficRoutingProviderProfile;
				expect(
					parseTrafficRoutingProviderProfile(
						JSON.parse(JSON.stringify(profile)),
					),
				).toEqual(JSON.parse(JSON.stringify(profile)));
				if (!row.coverageExport) return;
				// SAFETY: the named export is the package's HostingCoverage document.
				const coverage = module[row.coverageExport] as {
					contract: string;
					providerId: string;
					resolvedProductIds: readonly string[];
					unresolved: readonly { reason: string; remediation: string }[];
					traffic: {
						offerings: readonly string[];
						absent: readonly { reason: string }[];
					};
				};
				expect(coverage.contract).toBe(COVERAGE_CONTRACT);
				expect(coverage.providerId).toBe(row.providerId);
				expect(coverage.resolvedProductIds.length).toBeGreaterThan(0);
				if (row.resolvedProductIds)
					expect([...coverage.resolvedProductIds]).toEqual([
						...row.resolvedProductIds,
					]);
				expect([...coverage.traffic.offerings]).toEqual(profileIds(profile));
				expect(
					coverage.traffic.offerings.length + coverage.traffic.absent.length,
				).toBe(PORTABLE_OFFERINGS);
				for (const entry of [
					...coverage.unresolved,
					...coverage.traffic.absent,
				])
					expect(entry.reason.trim()).not.toBe("");
				for (const entry of coverage.unresolved)
					expect(entry.remediation.trim()).not.toBe("");
			},
		);
	}
});

describe("I14: typed refusal for everything that is not a delivery target", () => {
	for (const row of PROVIDER_DELIVERY_COVERAGE) {
		if (row.realization !== "refused") continue;
		it(`${row.packageName} refuses with RESOLVER_PRODUCT_UNSUPPORTED and a remediation`, () => {
			for (const key of [row.packageName, row.providerId]) {
				const refusal = providerDeliveryRefusal(key);
				expect(refusal).toBeInstanceOf(ResolverError);
				expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
				expect(refusal?.message).toContain("Remediation:");
			}
		});
	}

	it("an uncatalogued provider is refused, naming the out-of-tree component escape (D6)", () => {
		const refusal = providerDeliveryRefusal("@hobo/provider-nowhere");
		expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(refusal?.message).toContain("hobo:resolver");
	});
});

describe("traffic profiles: connectivity built-ins mirror the provider packages", () => {
	it("Vercel's audited profile is the same record in both places", () => {
		expect(JSON.parse(JSON.stringify(CONNECTIVITY_VERCEL))).toEqual(
			JSON.parse(JSON.stringify(VERCEL_PACKAGE)),
		);
	});
	it("Lakebed's profile is the same record in both places", () => {
		expect(JSON.parse(JSON.stringify(CONNECTIVITY_LAKEBED))).toEqual(
			JSON.parse(JSON.stringify(LAKEBED_PACKAGE)),
		);
	});
	it("Netlify's missing profile is now a built-in, equal to the package's", () => {
		const builtin = CONNECTIVITY_BUILTINS.find(
			(profile) =>
				profile.provider === "other" &&
				profile.offerings.some((entry) =>
					entry.features.includes("deploy-permalinks"),
				),
		);
		expect(JSON.parse(JSON.stringify(builtin))).toEqual(
			JSON.parse(JSON.stringify(NETLIFY_PACKAGE)),
		);
	});
});

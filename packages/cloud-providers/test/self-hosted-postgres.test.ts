/**
 * Self-hosted PostgreSQL on registered compute, driven from the real provider
 * declarations: each provider package's own `EQUIVALENCE_CLASSES` and its
 * parsed Yard catalog. No verdict below is keyed on a provider id — the
 * expectations are stated per provider only because that is what the answer
 * is *about*.
 */
import { assessSelfHostedDataStore, SELF_HOST_FACETS } from "@hobo/core";
import { EQUIVALENCE_CLASSES as HETZNER_CLASSES } from "@hobo/provider-hetzner";
import { EQUIVALENCE_CLASSES as VERCEL_CLASSES } from "@hobo/provider-vercel";
import { describe, expect, it } from "vitest";

import {
	PARITY_PROVIDERS,
	registeredHostDeclaration,
	registeredHostDeclarations,
	SELF_HOST_PROVIDERS,
	SELF_HOST_SOURCES,
	selfHostedPostgresHosts,
} from "../src/index.js";

function verdictOf(provider: (typeof SELF_HOST_PROVIDERS)[number]) {
	const found = selfHostedPostgresHosts().find(
		(entry) => entry.providerId === provider,
	);
	if (found === undefined) throw new Error(`no assessment for ${provider}`);
	return found;
}

describe("declarations are read off the provider packages", () => {
	it("assesses every namespace with a Yard catalog, plus Netlify and Railway", () => {
		expect(SELF_HOST_PROVIDERS).toEqual([
			...PARITY_PROVIDERS,
			"netlify",
			"railway",
		]);
		expect(Object.keys(SELF_HOST_SOURCES).sort()).toEqual(
			[...SELF_HOST_PROVIDERS].sort(),
		);
	});

	it("carries the provider package's own compute features, unedited", () => {
		expect(registeredHostDeclaration("vercel").compute).toEqual([
			{
				resourceClass: VERCEL_CLASSES["web/service"].resourceClass,
				providerService: VERCEL_CLASSES["web/service"].providerService,
				features: [...VERCEL_CLASSES["web/service"].features],
			},
		]);
		expect(registeredHostDeclaration("hetzner").compute[0]?.features).toEqual([
			...HETZNER_CLASSES["web/service"].features,
		]);
	});

	it("reads the catalog half from the parsed Yard", () => {
		const hetzner = registeredHostDeclaration("hetzner");
		expect(hetzner.catalog).toContainEqual({
			profile: "bucket.filesystem/v1",
			productId: "hetzner.volume/v1",
		});
		expect(registeredHostDeclaration("netlify").catalog).toEqual([]);
		expect(registeredHostDeclarations().map((d) => d.providerId)).toEqual(
			SELF_HOST_PROVIDERS,
		);
	});
});

describe("verdicts", () => {
	it("Vercel cannot: nothing it declares is a VM or a container", () => {
		const vercel = verdictOf("vercel");
		expect(vercel.verdict).toBe("cannot");
		expect(vercel.resourceClass).toBeUndefined();
		expect(vercel.summary).toContain("[http, static, managed]");
		expect(vercel.findings.map((finding) => finding.state)).toEqual(
			SELF_HOST_FACETS.map(() => "absent"),
		);
	});

	it("a VM provider with block storage can, on its declared volume", () => {
		const hetzner = verdictOf("hetzner");
		expect(hetzner.verdict).toBe("can");
		expect(hetzner.resourceClass).toBe("hetzner:cloud-server");
		expect(hetzner.missing).toEqual([]);
		expect(hetzner.caveats).toEqual([]);
		expect(
			hetzner.findings.find((f) => f.facet === "persistent-volume")?.reason,
		).toContain("hetzner.volume/v1");
	});

	it("a VM provider with no declared volume can, with the lifetime caveat", () => {
		const hostinger = verdictOf("hostinger");
		expect(hostinger.verdict).toBe("can");
		expect(hostinger.caveats).toHaveLength(1);
		expect(hostinger.caveats[0]).toContain("bucket.filesystem/v1");
	});

	it("static and edge platforms cannot", () => {
		for (const provider of ["cloudflare", "netlify"] as const) {
			expect(verdictOf(provider).verdict, provider).toBe("cannot");
		}
	});

	it("container declarations are undetermined, and say what is missing", () => {
		for (const provider of [
			"aws",
			"azure",
			"gcp",
			"digitalocean",
			"kubernetes",
			"railway",
		] as const) {
			const result = verdictOf(provider);
			expect(result.verdict, provider).toBe("undetermined");
			expect(result.missing, provider).toEqual(SELF_HOST_FACETS);
		}
	});

	it("a declared volume does not rescue a container that cannot be shown to mount it", () => {
		for (const provider of ["digitalocean", "kubernetes"] as const) {
			const declared = registeredHostDeclaration(provider).catalog.filter(
				(row) => row.profile === "bucket.filesystem/v1",
			);
			expect(declared.length, provider).toBeGreaterThan(0);
			expect(
				verdictOf(provider).findings.find(
					(f) => f.facet === "persistent-volume",
				)?.reason,
			).toContain("nothing declares that this container can mount it");
		}
	});

	it("partitions the registry three ways, with a reason on every row", () => {
		const by = Object.groupBy(selfHostedPostgresHosts(), (a) => a.verdict);
		expect((by.can ?? []).map((a) => a.providerId)).toEqual([
			"hetzner",
			"hostinger",
		]);
		expect((by.cannot ?? []).map((a) => a.providerId)).toEqual([
			"cloudflare",
			"vercel",
			"netlify",
		]);
		expect((by.undetermined ?? []).map((a) => a.providerId)).toEqual([
			"aws",
			"azure",
			"digitalocean",
			"gcp",
			"kubernetes",
			"railway",
		]);
		for (const assessment of selfHostedPostgresHosts()) {
			expect(assessment.summary.length).toBeGreaterThan(20);
			expect(assessment.findings).toHaveLength(SELF_HOST_FACETS.length);
		}
	});

	it("gives the same verdict to the same declaration under any provider id", () => {
		const vercel = registeredHostDeclaration("vercel");
		const hetzner = registeredHostDeclaration("hetzner");
		expect(
			assessSelfHostedDataStore({ ...vercel, providerId: "hetzner" }).verdict,
		).toBe("cannot");
		expect(
			assessSelfHostedDataStore({ ...hetzner, providerId: "vercel" }).verdict,
		).toBe("can");
	});

	it("an enriched container declaration becomes determinable without a code change", () => {
		const kubernetes = registeredHostDeclaration("kubernetes");
		const enriched = assessSelfHostedDataStore({
			...kubernetes,
			compute: kubernetes.compute.map((entry) => ({
				...entry,
				features: [
					...entry.features,
					"long-running",
					"persistent-volume",
					"tcp",
					"exec",
				],
			})),
		});
		expect(enriched.verdict).toBe("can");
	});
});

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

	it("a provider whose qualifying form is a declared Yard product can", () => {
		const expected = {
			aws: "aws.ec2-instance/v1",
			azure: "azure.virtual-machine/v1",
			gcp: "gcp.compute-engine-instance/v1",
			digitalocean: "digitalocean.droplet/v1",
			kubernetes: "kubernetes.statefulset/v1",
			railway: "railway:service",
		} as const;
		for (const [provider, target] of Object.entries(expected)) {
			// SAFETY: keys of `expected` are assessed provider ids by construction.
			const result = verdictOf(provider as keyof typeof expected);
			expect(result.verdict, provider).toBe("can");
			expect(result.resourceClass, provider).toBe(target);
			expect(result.missing, provider).toEqual([]);
		}
	});

	it("shows which form qualifies and which does not, per product", () => {
		const forms = (provider: "aws" | "digitalocean" | "kubernetes") =>
			verdictOf(provider).forms.map((form) => [form.target, form.verdict]);
		expect(forms("aws")).toEqual([
			["aws.ec2-instance/v1", "can"],
			["aws.ecs-service/v1", "can"],
			["aws.app-runner/v1", "cannot"],
		]);
		expect(forms("digitalocean")).toEqual([
			["digitalocean.droplet/v1", "can"],
			["digitalocean.app-platform-service/v1", "cannot"],
		]);
		// The Deployment equivalence class carries no cited form, so it stays
		// undetermined beside the StatefulSet that qualifies.
		expect(forms("kubernetes")).toEqual([
			["kubernetes.statefulset/v1", "can"],
			["kubernetes:deployment", "undetermined"],
		]);
	});

	it("realizes the volume from the Yard where the catalog has one", () => {
		for (const [provider, product] of [
			["aws", "aws.ebs-volume/v1"],
			["azure", "azure.managed-disk/v1"],
			["gcp", "gcp.persistent-disk/v1"],
			["digitalocean", "digitalocean.block-storage/v1"],
			["kubernetes", "kubernetes.persistent-volume-claim/v1"],
		] as const) {
			const result = verdictOf(provider);
			expect(result.caveats, provider).toEqual([]);
			expect(
				result.findings.find((f) => f.facet === "persistent-volume")?.reason,
			).toContain(product);
		}
		// The container forms on a network share stay listed, and stay caveated.
		for (const [provider, target] of [
			["aws", "aws.ecs-service/v1"],
			["azure", "azure.container-apps/v1"],
		] as const) {
			const form = verdictOf(provider).forms.find((f) => f.target === target);
			expect(form?.verdict, provider).toBe("can");
			expect(form?.caveats[0], provider).toContain(
				"no bucket.filesystem/v1 product",
			);
		}
		expect(verdictOf("railway").caveats[0]).toContain(
			"no bucket.filesystem/v1 product",
		);
	});

	it("the three hyperscalers qualify on a VM with every facet established", () => {
		for (const provider of ["aws", "azure", "gcp"] as const) {
			const result = verdictOf(provider);
			expect(result.verdict, provider).toBe("can");
			expect(result.caveats, provider).toEqual([]);
			expect(
				result.findings.map((finding) => finding.state),
				provider,
			).toEqual(SELF_HOST_FACETS.map(() => "declared"));
		}
		// Cloud Run stays listed and stays undetermined beside the VM.
		expect(
			verdictOf("gcp").forms.map((form) => [form.target, form.verdict]),
		).toEqual([
			["gcp.compute-engine-instance/v1", "can"],
			["gcp.cloud-run/v1", "undetermined"],
		]);
	});

	it("names only products and classes the provider already declares", () => {
		for (const provider of SELF_HOST_PROVIDERS) {
			const source = SELF_HOST_SOURCES[provider];
			const rows = source.catalog();
			const products = new Set(rows.map((row) => row.productId));
			const classes = new Set(
				Object.values(source.equivalenceClasses).map((c) => c.resourceClass),
			);
			for (const form of source.hostForms ?? []) {
				if (form.productId !== undefined) {
					expect(products, form.productId).toContain(form.productId);
				}
				if (form.resourceClass !== undefined) {
					expect(classes, form.resourceClass).toContain(form.resourceClass);
				}
				if (form.volumeProductId !== undefined) {
					expect(rows).toContainEqual({
						profile: "bucket.filesystem/v1",
						productId: form.volumeProductId,
					});
				}
			}
		}
	});

	it("cites the vendor's own documentation for every form and facet", () => {
		const domains = {
			aws: ["docs.aws.amazon.com"],
			azure: ["learn.microsoft.com"],
			gcp: ["cloud.google.com"],
			digitalocean: ["docs.digitalocean.com"],
			kubernetes: ["kubernetes.io"],
			railway: ["docs.railway.com"],
		} as const;
		for (const [provider, hosts] of Object.entries(domains)) {
			// SAFETY: keys of `domains` are assessed provider ids by construction.
			const forms =
				SELF_HOST_SOURCES[provider as keyof typeof domains].hostForms;
			expect(forms?.length, provider).toBeGreaterThan(0);
			for (const form of forms ?? []) {
				const cited = [
					...form.formSources,
					...form.facets.flatMap((claim) => claim.sources),
				];
				for (const source of cited) {
					expect(hosts).toContain(new URL(source.url).host);
					expect(source.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
				}
			}
		}
	});

	it("partitions the registry three ways, with a reason on every row", () => {
		const by = Object.groupBy(selfHostedPostgresHosts(), (a) => a.verdict);
		expect((by.can ?? []).map((a) => a.providerId)).toEqual([
			"aws",
			"azure",
			"digitalocean",
			"gcp",
			"hetzner",
			"hostinger",
			"kubernetes",
			"railway",
		]);
		expect((by.cannot ?? []).map((a) => a.providerId)).toEqual([
			"cloudflare",
			"vercel",
			"netlify",
		]);
		expect(by.undetermined ?? []).toEqual([]);
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

	it("a token-enriched class still becomes determinable without a code change", () => {
		const netlify = registeredHostDeclaration("netlify");
		const enriched = assessSelfHostedDataStore({
			...netlify,
			compute: netlify.compute.map((entry) => ({
				...entry,
				features: [
					"container",
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

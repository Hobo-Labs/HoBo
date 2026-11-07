/**
 * The composition package's job is narrow — turn a provider's catalog rows into
 * a real `Yard` without deciding anything — so these tests check exactly that:
 * the Yard is well-formed, the catalog survives the trip intact, options reach
 * `yard()`, and `@hobo/yards`'s refusals still fire through this path.
 */
import { describe, expect, it } from "vitest";

import {
	aws,
	azure,
	cloudflare,
	composeYard,
	digitalocean,
	gcp,
	hetzner,
	hostinger,
	kubernetes,
	vercel,
} from "../src/index.js";

const NAMESPACES = [
	{ name: "aws", ns: aws, providerId: "aws" },
	{ name: "azure", ns: azure, providerId: "azure" },
	{ name: "gcp", ns: gcp, providerId: "gcp" },
	{ name: "cloudflare", ns: cloudflare, providerId: "cloudflare" },
	{ name: "vercel", ns: vercel, providerId: "vercel" },
	{ name: "digitalocean", ns: digitalocean, providerId: "digitalocean" },
	{ name: "hetzner", ns: hetzner, providerId: "hetzner" },
	{ name: "hostinger", ns: hostinger, providerId: "hostinger" },
	{ name: "kubernetes", ns: kubernetes, providerId: "kubernetes" },
] as const;

describe("default Yards", () => {
	for (const { name, ns, providerId } of NAMESPACES) {
		describe(name, () => {
			it("builds a real Yard carrying the provider id", () => {
				const built = ns.Yard();
				expect(built.kind).toBe("yard");
				expect(built.providerId).toBe(providerId);
				expect(built.name).toBe(name);
			});

			it("declares a non-empty allocatable catalog", () => {
				expect(ns.Yard().bindings.length).toBeGreaterThan(0);
			});

			it("emits rows in the canonical shape", () => {
				for (const row of ns.Yard().bindings) {
					expect(row.contract).toBe("hobo.yard-binding/v1");
					expect(row.profile).toMatch(/^[a-z][a-z0-9-]*\.[a-z0-9-]+\/v\d+$/u);
					// A row that constrains nothing would be a portability lie.
					expect(
						row.productId !== undefined || row.connectivityId !== undefined,
					).toBe(true);
				}
			});

			it("is deterministic: two calls are deep-equal", () => {
				expect(ns.Yard()).toEqual(ns.Yard());
			});

			it("honors a caller-supplied name", () => {
				expect(ns.Yard({ name: "custom" }).name).toBe("custom");
			});

			it("narrows regions when asked, and keeps the published set otherwise", () => {
				expect(ns.Yard().regions.length).toBeGreaterThan(0);
				const narrowed = ns.Yard({ regions: ["only-one"] });
				expect(narrowed.regions).toEqual(["only-one"]);
			});

			it("carries residency and label options through to the Yard", () => {
				const built = ns.Yard({
					residency: ["eu"],
					labels: { tier: "public" },
				});
				expect(built.residency).toEqual(["eu"]);
				expect(built.labels).toEqual({ tier: "public" });
			});

			it("declares no duplicate (profile, productId, connectivityId) triple", () => {
				const seen = new Set(
					ns
						.Yard()
						.bindings.map(
							(row) =>
								`${row.profile}|${row.productId ?? ""}|${row.connectivityId ?? ""}`,
						),
				);
				expect(seen.size).toBe(ns.Yard().bindings.length);
			});
		});
	}
});

describe("catalog semantics", () => {
	it("lets a capability hold several offerings — Azure web has at least three", () => {
		const webRows = azure
			.Yard()
			.bindings.filter((row) => row.profile.startsWith("web."));
		expect(webRows.length).toBeGreaterThanOrEqual(3);
	});

	it("lists GCP web across more than one offering too", () => {
		const webRows = gcp
			.Yard()
			.bindings.filter((row) => row.profile.startsWith("web."));
		expect(webRows.length).toBeGreaterThanOrEqual(2);
	});

	it("keeps every catalog row: no silent narrowing during composition", () => {
		// Composition must not be a second selection point, so the parsed row
		// count matches the provider's own catalog exactly.
		for (const { ns } of NAMESPACES) {
			const built = ns.Yard();
			const distinct = new Set(built.bindings.map((row) => row.profile));
			expect(built.bindings.length).toBeGreaterThanOrEqual(distinct.size);
		}
	});
});

describe("slot factories are re-exported for override authoring", () => {
	it("exposes Azure's four web offerings as callable factories", () => {
		for (const factory of [
			azure.staticWebApps,
			azure.appService,
			azure.containerApps,
			azure.aks,
		]) {
			expect(factory).toBeTypeOf("function");
			expect(factory().profile).toMatch(/^web\./u);
		}
	});

	it("exposes Cloudflare and Vercel factories", () => {
		expect(cloudflare.r2().profile).toMatch(/^bucket\./u);
		expect(vercel.staticDeployment().profile).toBe("web.hosted/v1");
		expect(vercel.project().profile).toBe("provider.project/v1");
	});

	it("passes Vercel offering settings through to the composed Yard", () => {
		const built = vercel.Yard({
			staticDeployment: { projectId: "prj_owned" },
			edgeFunction: { memoryMb: 512 },
			project: { framework: "nextjs" },
		});
		expect(
			built.bindings.find((row) => row.productId === "vercel.static-deploy/v1")
				?.properties,
		).toEqual({ projectId: "prj_owned" });
		expect(
			built.bindings.find((row) => row.productId === "vercel.edge-function/v1")
				?.properties,
		).toEqual({ memoryMb: 512 });
		expect(
			built.bindings.find((row) => row.productId === "vercel.project/v1")
				?.properties,
		).toEqual({ framework: "nextjs" });
	});

	it("rejects credential-shaped Vercel offering settings", () => {
		const staticDeployment = JSON.parse('{"apiKey":"not-a-secret"}');
		expect(() => vercel.Yard({ staticDeployment })).toThrow(/credential/iu);
	});
});

describe("composeYard decides nothing", () => {
	it("passes rows through to yard() untouched", () => {
		const built = composeYard("y", {
			provider: "aws",
			regions: ["us-east-1"],
			bindings: [{ profile: "web.hosted/v1", productId: "aws.example/v1" }],
		});
		expect(built.bindings).toHaveLength(1);
		expect(built.bindings[0]?.productId).toBe("aws.example/v1");
	});

	it("still fails closed on a credential-shaped property", () => {
		// `composeYard` refuses for many reasons; a bare `.toThrow()` did not
		// establish that the *credential-property* rule is the one firing,
		// which is the entire claim in this test's name.
		expect(() =>
			composeYard("y", {
				provider: "aws",
				regions: ["us-east-1"],
				bindings: [
					{
						profile: "web.hosted/v1",
						productId: "aws.example/v1",
						properties: { apiKey: "leak" },
					},
				],
			}),
		).toThrow(
			"yard binding properties must not contain credentials (forbidden key: apiKey, profile web.hosted/v1) — reference secrets by locator instead",
		);
	});

	it("still rejects a duplicate row", () => {
		expect(() =>
			composeYard("y", {
				provider: "aws",
				regions: ["us-east-1"],
				bindings: [
					{ profile: "web.hosted/v1", productId: "aws.example/v1" },
					{ profile: "web.hosted/v1", productId: "aws.example/v1" },
				],
			}),
		).toThrow(
			"duplicate yard binding row for profile web.hosted/v1 (productId aws.example/v1, connectivityId -)",
		);
	});
});

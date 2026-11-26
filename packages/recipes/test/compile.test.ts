import { describe, expect, it } from "vitest";

import {
	compileRecipe,
	DEFAULT_RECIPE_POLICY,
	findStandardRecipe,
	parseDeploymentRequest,
	parseSolutionRecipe,
	type RecipeCompilation,
	type RecipeCompilationAccepted,
	type SolutionRecipe,
	STANDARD_SOLUTION_RECIPES,
} from "../src/index.js";
import {
	CATALOG,
	CATALOG_DIGEST,
	capabilityFor,
	catalogDigestOf,
	compileInputFor,
	connectivity,
	EVIDENCE,
	NOW,
	policyWith,
	registry,
	requestForRecipe,
	VERIFIER,
} from "./fixtures.js";

function requireRecipe(id: string): SolutionRecipe {
	const recipe = findStandardRecipe(id);
	if (recipe === undefined) throw new Error(`missing fixture recipe ${id}`);
	return recipe;
}

function accepted(compilation: RecipeCompilation): RecipeCompilationAccepted {
	if (!compilation.ok) {
		throw new Error(
			`expected an accepted compilation, got: ${compilation.rejections
				.map((rejection) => `${rejection.code} ${rejection.detail}`)
				.join(" | ")}`,
		);
	}
	return compilation;
}

function codes(compilation: RecipeCompilation): readonly string[] {
	return compilation.rejections.map((rejection) => rejection.code);
}

const inbox = requireRecipe("recipe.cloudflare.claimable-webhook-inbox/v1");
const sqlApi = requireRecipe("recipe.cloudflare-neon.portable-sql-api/v1");
const issueTracker = requireRecipe(
	"recipe.vercel-prisma.claimable-issue-tracker/v1",
);
const polyglot = requireRecipe(
	"recipe.cloudflare-neon-upstash.polyglot-saas/v1",
);

describe("compileRecipe", () => {
	it("compiles every first-party recipe against the request it advertises", () => {
		for (const recipe of STANDARD_SOLUTION_RECIPES) {
			const compilation = compileRecipe(compileInputFor(recipe));
			expect(
				compilation.ok
					? "ok"
					: compilation.rejections
							.map((rejection) => rejection.detail)
							.join(" | "),
			).toBe("ok");
		}
	});

	it("resolves the Junction/Yard/Camp/resource hierarchy without adding a primitive", () => {
		const result = accepted(compileRecipe(compileInputFor(inbox)));
		expect(result.topology.junctionRef).toBe(
			requestForRecipe(inbox).deploymentRef,
		);
		expect(result.topology.yards).toHaveLength(1);
		const [yard] = result.topology.yards;
		expect(yard?.providerId).toBe("cloudflare");
		expect(yard?.camps.map((camp) => camp.campId)).toEqual(["app"]);
		expect(
			yard?.camps[0]?.resources.map((resource) => resource.placementId),
		).toEqual(["inbox", "log"]);
		expect(yard?.resources).toEqual([]);
	});

	it("keeps a resource-only Yard bare instead of inventing an empty Camp", () => {
		const result = accepted(compileRecipe(compileInputFor(sqlApi)));
		const data = result.topology.yards.find((yard) => yard.yardId === "data");
		expect(data?.resourceOnly).toBe(true);
		expect(data?.camps).toEqual([]);
		expect(data?.resources.map((resource) => resource.placementId)).toEqual([
			"db",
		]);
	});

	it("derives claim facts, not a claim reducer of its own", () => {
		const result = accepted(compileRecipe(compileInputFor(sqlApi)));
		expect(result.claims.actionCount).toBe(2);
		expect(result.claims.providerCount).toBe(2);
		// Two providers cannot bundle a handover between them.
		expect(result.claims.atomicity).toBe("best-effort-saga");
		expect(result.claims.earliestDeadlineMs).toBe(NOW + 24 * 60 * 60 * 1000);
		expect(result.claims.items.map((item) => item.claimId)).toEqual([
			"claim/api",
			"claim/db",
		]);
	});

	it("excludes placements claimed by their account from the claim count", () => {
		const result = accepted(compileRecipe(compileInputFor(inbox)));
		expect(result.claims.items.map((item) => item.claimId)).toEqual([
			"claim/inbox",
		]);
		expect(result.claims.actionCount).toBe(1);
	});

	it("emits one guest lease per Yard with an absolute claim-by instant", () => {
		const result = accepted(compileRecipe(compileInputFor(sqlApi)));
		expect(result.guestLeases.map((lease) => lease.leaseId)).toEqual([
			"lease/data",
			"lease/edge",
		]);
		for (const lease of result.guestLeases) {
			expect(lease.claimByMs).toBe(NOW + 24 * 60 * 60 * 1000);
		}
	});

	it("rejects a recipe that leaves a required capability unplaced", () => {
		const request = parseDeploymentRequest({
			deploymentRef: "junction/partial",
			capabilities: [
				capabilityFor("inbox", "webhook.inbound-http/v1"),
				capabilityFor("log", "kv.key-value/v1"),
				capabilityFor("extra", "bucket.object/v1"),
			],
			requestedSemantics: inbox.delivers,
		});
		const compilation = compileRecipe(compileInputFor(inbox, { request }));
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("PROFILE_INCOMPATIBLE");
		expect(
			compilation.rejections.some((rejection) =>
				rejection.detail.includes("leaves required capability extra unplaced"),
			),
		).toBe(true);
	});

	it("rejects a recipe that covers a capability the bindle never declared", () => {
		const request = parseDeploymentRequest({
			deploymentRef: "junction/narrow",
			capabilities: [capabilityFor("inbox", "webhook.inbound-http/v1")],
			requestedSemantics: inbox.delivers,
		});
		const compilation = compileRecipe(compileInputFor(inbox, { request }));
		expect(compilation.ok).toBe(false);
		expect(
			compilation.rejections.some((rejection) =>
				rejection.detail.includes("which the bindle does not declare"),
			),
		).toBe(true);
	});

	it("rejects a placement that reinterprets the primitive the bindle asked for", () => {
		const request = parseDeploymentRequest({
			deploymentRef: "junction/mismatched-primitive",
			capabilities: [
				capabilityFor("inbox", "webhook.inbound-http/v1"),
				// The recipe provisions a kv store for this slot.
				{ ...capabilityFor("log", "kv.key-value/v1"), primitive: "bucket" },
			],
			requestedSemantics: inbox.delivers,
		});
		const compilation = compileRecipe(compileInputFor(inbox, { request }));
		expect(compilation.ok).toBe(false);
		expect(
			compilation.rejections.some((rejection) =>
				rejection.detail.includes(
					"is a bucket slot but the placement provisions a kv",
				),
			),
		).toBe(true);
	});

	it("rejects a product that is absent from the catalog snapshot", () => {
		const thinned = CATALOG.filter(
			(candidate) => candidate.definitionId !== "cloudflare.temporary-kv/v1",
		);
		const compilation = compileRecipe(
			compileInputFor(inbox, {
				catalog: thinned,
				catalogDigest: catalogDigestOf(thinned),
			}),
		);
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("NO_REGISTERED_DRIVER");
	});

	it("rejects a product whose provider does not own the Yard it is placed in", () => {
		const relabelled = CATALOG.map((candidate) =>
			candidate.definitionId === "neon.claimable-postgres/v1"
				? { ...candidate, providerId: "someone-else" }
				: candidate,
		);
		const compilation = compileRecipe(
			compileInputFor(sqlApi, {
				catalog: relabelled,
				catalogDigest: catalogDigestOf(relabelled),
			}),
		);
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("ARCHITECTURE_UNSUPPORTED");
	});

	it("falls back to the tested Neon serverless driver when Hyperdrive is unavailable", () => {
		const withoutHyperdrive = {
			list: () => connectivity.list(),
			resolve: (query: Parameters<typeof connectivity.resolve>[0]) =>
				connectivity
					.resolve(query)
					.filter(
						(implementation) =>
							implementation.id !== "cloudflare.postgres.hyperdrive/v1",
					),
		};
		const result = accepted(
			compileRecipe(
				compileInputFor(sqlApi, { connectivity: withoutHyperdrive }),
			),
		);
		const binding = result.topology.bindings.find(
			(entry) => entry.edgeId === "api-db",
		);
		expect(binding?.connectivityImplementationId).toBe(
			"cloudflare.postgres.neon-serverless/v1",
		);
		expect(binding?.usedFallback).toBe(true);
		expect(binding?.crossYard).toBe(true);
	});

	it("rejects an edge when neither the primary nor the fallback resolves", () => {
		const empty = {
			list: () => [],
			resolve: () => [],
		};
		const compilation = compileRecipe(
			compileInputFor(sqlApi, { connectivity: empty }),
		);
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("BINDING_UNAVAILABLE");
	});

	it("rejects a cross-Yard dependency that no edge wires up", () => {
		const unwired = parseSolutionRecipe({
			...sqlApi,
			id: "recipe.test.unwired/v1",
			edges: [],
		});
		const request = parseDeploymentRequest({
			deploymentRef: "junction/unwired",
			capabilities: sqlApi.placements.map((placement) =>
				capabilityFor(placement.capabilityRef, placement.satisfiesProfileId),
			),
			dependencies: [{ fromCapabilityRef: "api", toCapabilityRef: "db" }],
			requestedSemantics: sqlApi.delivers,
		});
		const compilation = compileRecipe(compileInputFor(unwired, { request }));
		expect(compilation.ok).toBe(false);
		expect(
			compilation.rejections.some(
				(rejection) =>
					rejection.code === "BINDING_UNAVAILABLE" &&
					rejection.detail.includes("no declared connectivity edge"),
			),
		).toBe(true);
	});

	it("rejects more provider boundaries than policy allows", () => {
		const compilation = compileRecipe(
			compileInputFor(polyglot, {
				policy: policyWith({ maximumClaimActions: 3 }),
			}),
		);
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("ARCHITECTURE_UNSUPPORTED");
	});

	it("rejects more human claim actions than policy allows", () => {
		const compilation = compileRecipe(
			compileInputFor(polyglot, {
				policy: policyWith({ maximumProviderCount: 3 }),
			}),
		);
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("TOO_MANY_CLAIM_ACTIONS");
	});

	it("rejects sponsor exposure above the policy cap", () => {
		const compilation = compileRecipe(
			compileInputFor(issueTracker, { policy: DEFAULT_RECIPE_POLICY }),
		);
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("SPONSOR_BUDGET_EXCEEDED");
	});

	it("rejects a claim window shorter than the policy minimum", () => {
		const compilation = compileRecipe(
			compileInputFor(inbox, {
				policy: policyWith({ minimumClaimWindowMs: 48 * 60 * 60 * 1000 }),
			}),
		);
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("CLAIM_MODE_INSUFFICIENT");
	});

	it("accepts a one-hour deadline exactly at the policy minimum", () => {
		const report = requireRecipe(
			"recipe.netlify.claimable-generated-report/v1",
		);
		const result = accepted(compileRecipe(compileInputFor(report)));
		expect(result.claims.earliestDeadlineMs).toBe(NOW + 60 * 60 * 1000);
	});

	it("fails closed on stale evidence rather than ranking it lower", () => {
		const stale = EVIDENCE.filter(
			(record) =>
				record.productDefinitionId !== "cloudflare.temporary-workers-api/v1",
		);
		const compilation = compileRecipe(
			compileInputFor(inbox, { evidence: stale }),
		);
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("EVIDENCE_STALE");
	});

	it("fails closed when no trust root vouches for the evidence", () => {
		const compilation = compileRecipe(
			compileInputFor(inbox, {
				verifier: {
					id: "hobo.test-hostile-root/v1",
					verify: () => "invalid" as const,
				},
			}),
		);
		expect(compilation.ok).toBe(false);
		expect(codes(compilation)).toContain("EVIDENCE_STALE");
	});

	it("refuses a non-integer instant and a malformed catalog digest", () => {
		expect(() => compileRecipe(compileInputFor(inbox, { nowMs: 1.5 }))).toThrow(
			/nowMs must be an integer/u,
		);
		expect(() =>
			compileRecipe(compileInputFor(inbox, { catalogDigest: "not-a-digest" })),
		).toThrow(/catalogDigest/u);
	});

	it("reads no clock: the same inputs at a different instant differ only in derived deadlines", () => {
		const first = accepted(compileRecipe(compileInputFor(inbox)));
		const later = accepted(
			compileRecipe(compileInputFor(inbox, { nowMs: NOW + 1000 })),
		);
		expect(later.claims.earliestDeadlineMs).toBe(
			(first.claims.earliestDeadlineMs ?? 0) + 1000,
		);
		expect(later.topologyDigest).toBe(first.topologyDigest);
	});

	it("does not fold the catalog digest into the resolution digest", () => {
		const first = accepted(compileRecipe(compileInputFor(inbox)));
		const second = accepted(
			compileRecipe(
				compileInputFor(inbox, {
					catalogDigest: catalogDigestOf([...CATALOG].reverse()),
				}),
			),
		);
		expect(second.resolutionDigest).toBe(first.resolutionDigest);
		expect(CATALOG_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	it("uses the registry and evidence it was handed, never a module-level default", () => {
		const result = accepted(compileRecipe(compileInputFor(inbox)));
		expect(result.trustEvidenceRefs).toEqual([
			expect.stringContaining("cloudflare.temporary-kv/v1#sha256:"),
			expect.stringContaining("cloudflare.temporary-workers-api/v1#sha256:"),
		]);
		expect(result.conformanceEvidenceRefs).toEqual([
			"conformance/cloudflare.temporary-kv/v1/kv.key-value/v1",
			"conformance/cloudflare.temporary-workers-api/v1/webhook.inbound-http/v1",
		]);
		expect(registry.digest).toMatch(/^sha256:/u);
		expect(VERIFIER.id).toBe("hobo.test-trust-root/v1");
	});
});

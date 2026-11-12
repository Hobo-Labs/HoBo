/**
 * Resolver conformance kit (plan 0024 WP13, I14). Test-only and identical in
 * every WP13 provider package: each package drives its own shipped registry
 * through the same contract checks on recorded fixtures.
 *
 * What a conforming hosting resolver must show:
 * - the registry lists exactly the products the coverage document resolves;
 * - outcomes cross `parseResolveOutcome` and carry the contract stamp;
 * - reconcile is idempotent on a converged fixture (same outcome, no mutation);
 * - `read` exists and agrees with reconcile on the physical identity;
 * - lifecycle observation through core's `observeResolverLifecycle` reaches
 *   `ready` on a ready fixture (an observation, never an assumption, I5);
 * - credential material never reaches an outcome or an error (I9);
 * - every catalogued-but-unresolved product refuses with the typed
 *   `RESOLVER_PRODUCT_UNSUPPORTED` and a remediation.
 */
import {
	type HttpTransport,
	observeResolverLifecycle,
	parseResolveOutcome,
	RESOLVER_CONTRACT,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import type { HostingCoverage } from "../../src/delivery-coverage.js";
import { hostingProductRefusal } from "../../src/delivery-coverage.js";

export interface ResolverConformanceFixture {
	readonly registry: {
		get(productId: string): ResourceResolver | undefined;
		list(): readonly ResourceResolver[];
	};
	readonly coverage: HostingCoverage;
	/** A request whose fixture world is already converged and ready. */
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	/** Count of mutating provider calls the fixture has observed so far. */
	readonly mutations: () => number;
	/** Credential material the resolver had access to; it must never leak. */
	readonly secret?: string;
}

export function describeResolverConformance(
	name: string,
	make: () => ResolverConformanceFixture,
): void {
	describe(`resolver conformance: ${name}`, () => {
		it("registry lists exactly the resolved hosting products of the coverage", () => {
			const fixture = make();
			expect(fixture.registry.list().map((entry) => entry.productId)).toEqual([
				...fixture.coverage.resolvedProductIds,
			]);
			for (const resolver of fixture.registry.list()) {
				expect(resolver.providerId).toBe(fixture.coverage.providerId);
				expect(resolver.read).toBeInstanceOf(Function);
			}
		});

		it("reconcile is convergent: parseable, stamped, idempotent, no mutation on a converged world", async () => {
			const fixture = make();
			const resolver = fixture.registry.get(fixture.request.ref.productId);
			if (!resolver) throw new Error("fixture product is not registered");
			const before = fixture.mutations();
			const first = parseResolveOutcome(
				JSON.parse(
					JSON.stringify(
						await resolver.reconcile(fixture.request, fixture.transport),
					),
				),
			);
			const second = parseResolveOutcome(
				JSON.parse(
					JSON.stringify(
						await resolver.reconcile(fixture.request, fixture.transport),
					),
				),
			);
			expect(first.contract).toBe(RESOLVER_CONTRACT);
			expect(second).toEqual(first);
			expect(fixture.mutations()).toBe(before);
		});

		it("read agrees with reconcile on physical identity", async () => {
			const fixture = make();
			const resolver = fixture.registry.get(fixture.request.ref.productId);
			if (!resolver?.read) throw new Error("fixture resolver cannot read");
			const read = await resolver.read(fixture.request, fixture.transport);
			const reconciled = await resolver.reconcile(
				fixture.request,
				fixture.transport,
			);
			expect(read?.physicalId).toBe(reconciled.physicalId);
		});

		it("lifecycle observation reaches ready only through the shipped read", async () => {
			const fixture = make();
			const resolver = fixture.registry.get(fixture.request.ref.productId);
			if (!resolver) throw new Error("fixture product is not registered");
			const observation = await observeResolverLifecycle({
				resolver,
				request: fixture.request,
				transport: fixture.transport,
				context: {
					tenantId: "tenant-one",
					providerId: resolver.providerId,
					providerAccountId: "account-one",
					productId: resolver.productId,
					resourceId: fixture.request.ref.logicalId,
					operationId: "operation-one",
					nowMs: 1_000,
					maxAgeMs: 60_000,
					evidenceRef: "evidence://conformance",
				},
			});
			expect(observation.status).toBe("ready");
			expect(observation.operationTerminal).toBe(true);
		});

		it("never leaks credential material into outcomes", async () => {
			const fixture = make();
			if (!fixture.secret) return;
			const resolver = fixture.registry.get(fixture.request.ref.productId);
			if (!resolver?.read) throw new Error("fixture resolver cannot read");
			const outcomes = [
				await resolver.reconcile(fixture.request, fixture.transport),
				await resolver.read(fixture.request, fixture.transport),
			];
			expect(JSON.stringify(outcomes)).not.toContain(fixture.secret);
		});

		it("every unresolved hosting product refuses with typed RESOLVER_PRODUCT_UNSUPPORTED and a remediation", () => {
			const fixture = make();
			for (const entry of fixture.coverage.unresolved) {
				expect(fixture.registry.get(entry.productId)).toBeUndefined();
				const refusal = hostingProductRefusal(
					fixture.coverage,
					entry.productId,
				);
				expect(refusal).toBeInstanceOf(ResolverError);
				expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
				expect(refusal?.productId).toBe(entry.productId);
				expect(refusal?.message).toContain("Remediation:");
			}
			for (const productId of fixture.coverage.resolvedProductIds)
				expect(
					hostingProductRefusal(fixture.coverage, productId),
				).toBeUndefined();
			expect(
				hostingProductRefusal(fixture.coverage, "nobody.product/v1")?.code,
			).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		});
	});
}

/**
 * The projection is only useful if the real catalog accepts it.
 *
 * `@hobo/cloud` is a dev dependency here, not a runtime one: the framework
 * publishes a structural projection rather than importing the catalog package,
 * so a pack can be described without pulling the control plane in. This test is
 * what keeps that structural claim honest — it assigns the projection to the
 * real `ResourceDefinitionSemantics`, runs the real
 * `parseResourceDefinitionVNext` over it, and re-derives a candidate with the
 * real `toSelectionCandidate`. If either type drifts, this file stops compiling.
 */
import assert from "node:assert/strict";
import {
	parseResourceDefinitionVNext,
	RESOURCE_DEFINITION_VNEXT_SCHEMA,
	type ResourceDefinitionSemantics,
	type ResourceDefinitionVNext,
	toSelectionCandidate,
} from "@hobo/cloud";
import { describe, it } from "vitest";

import {
	RESOURCE_DEFINITION_VNEXT_SCHEMA as FRAMEWORK_SCHEMA,
	type PackSemanticsOptions,
	parsePackManifest,
	toPackResourceSemantics,
	toPackSelectionCandidate,
	verifyPackManifest,
} from "../src/index.js";
import { FIXTURE_ANCHORS, fixtureManifest, stubVerifier } from "./harness.js";

const verified = verifyPackManifest({
	manifest: parsePackManifest(fixtureManifest()),
	verifier: stubVerifier("valid"),
	anchors: {
		trustedKeyIds: [...FIXTURE_ANCHORS.trustedKeyIds],
		allowedRegistries: [...FIXTURE_ANCHORS.allowedRegistries],
	},
	requestedArchitecture: "linux/amd64",
});

const OPTIONS: PackSemanticsOptions = {
	definitionId: "hobo.pack.example-oci/v1",
	providerId: "yard.local",
	compilerRef: "hobo.compiler.pack-oci/v1",
	executorRef: "hobo.executor.pack-oci/v1",
	permissionProfileRef: "hobo.permission.pack-container/v1",
	bootstrapStrategyRef: "hobo.bootstrap.pack-container/v1",
	trustEvidenceRef: "hobo.trust.pack-signature/v1",
	evidenceExpiresAtMs: 4_000_000_000_000,
	evidenceSignatureValid: true,
	structuredCapabilities: { maxConnections: 100 },
};

function definitionFor(
	semantics: ResourceDefinitionSemantics,
): ResourceDefinitionVNext {
	return {
		id: OPTIONS.definitionId,
		providerId: OPTIONS.providerId,
		port: "kv",
		features: [],
		regions: ["local"],
		specificity: 1,
		priority: 1,
		cost: { sku: "pack-container", unit: "hour", marginalPrice: "0.00" },
		satisfies: () => ({ kind: "full" }),
		semantics,
	};
}

describe("pack semantics against the real catalog types", () => {
	it("produces a semantics block the catalog type accepts and the parser admits", () => {
		// The annotation is the assertion: no cast, so assignability is checked.
		const semantics: ResourceDefinitionSemantics = toPackResourceSemantics(
			verified,
			OPTIONS,
		);
		assert.equal(semantics.schemaVersion, RESOURCE_DEFINITION_VNEXT_SCHEMA);
		assert.equal(FRAMEWORK_SCHEMA, RESOURCE_DEFINITION_VNEXT_SCHEMA);
		const definition = parseResourceDefinitionVNext(definitionFor(semantics));
		assert.equal(definition.semantics?.productId, "pack.example.oci/v1");
	});

	it("advertises every profile as realization pack, never as provider-native", () => {
		const semantics = toPackResourceSemantics(verified, OPTIONS);
		assert.ok(semantics.implementsProfiles.length > 0);
		for (const implementation of semantics.implementsProfiles) {
			assert.equal(implementation.realization, "pack");
		}
		assert.equal(semantics.structuredCapabilities.managedProviderClaim, false);
		assert.equal(semantics.structuredCapabilities.imageDigestPinned, true);
	});

	it("routes ownership through the pack strategy rather than a provider claim", () => {
		const yardOwned = toPackResourceSemantics(verified, OPTIONS);
		assert.equal(
			yardOwned.claimStrategyRef,
			"hobo.pack-ownership.yard-owned/v1",
		);
		assert.equal(yardOwned.creatorAuthorityAfterClaim, "absent");
		assert.equal(yardOwned.claimActionCount, 0);
		assert.equal(yardOwned.continuity.endpoint, "preserved");
		assert.equal(yardOwned.sponsorExposureMinorUnits, 0);

		const migrating = toPackResourceSemantics(
			verifyPackManifest({
				manifest: parsePackManifest(
					fixtureManifest((draft) => ({
						...draft,
						ownership: "migrate-on-claim",
					})),
				),
				verifier: stubVerifier("valid"),
				anchors: {
					trustedKeyIds: [...FIXTURE_ANCHORS.trustedKeyIds],
					allowedRegistries: [...FIXTURE_ANCHORS.allowedRegistries],
				},
				requestedArchitecture: "linux/amd64",
			}),
			OPTIONS,
		);
		assert.equal(
			migrating.claimStrategyRef,
			"hobo.pack-ownership.migrate-on-claim/v1",
		);
		assert.equal(migrating.claimActionCount, 1);
		// A migration is not a no-op and does not claim to be one.
		assert.equal(migrating.continuity.endpoint, "rebound");
		assert.equal(migrating.continuity.data, "migrated");
		assert.equal(migrating.continuity.credentials, "rotated");
	});

	it("matches the candidate the catalog itself would derive", () => {
		const semantics: ResourceDefinitionSemantics = toPackResourceSemantics(
			verified,
			OPTIONS,
		);
		const viaCatalog = toSelectionCandidate(definitionFor(semantics));
		const viaFramework = toPackSelectionCandidate(verified, OPTIONS);
		assert.deepEqual(viaFramework, viaCatalog);
	});
});

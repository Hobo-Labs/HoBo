import assert from "node:assert/strict";
import {
	createCapabilityProfileRegistry,
	parseCapabilityProfile,
	parseProfileId,
	type SelectionCandidate,
	STANDARD_CAPABILITY_PROFILES,
} from "@hobo/capability-profiles";
import { describe, it } from "vitest";

import {
	createTtlShArtifactTransportCandidate,
	TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE,
	TTL_SH_ARTIFACT_TRANSPORT_PROFILE,
	TTL_SH_ARTIFACT_TRANSPORT_PROFILE_ID,
	TTL_SH_CLAIM_ACTION_COUNT,
	TTL_SH_CLAIM_MODE,
	TTL_SH_CLEANUP_POLICY,
	TTL_SH_DEFINITION_ID,
	TTL_SH_EVIDENCE_CHECKED_AT,
	TTL_SH_RESOURCE_DEFINITION,
	TTL_SH_RESOURCE_SEMANTICS,
	TTL_SH_SOURCE_REFS,
} from "../src/definition.js";

describe("the ttl.sh product is never claimable, ownable, or durable", () => {
	it("exposes zero claim actions", () => {
		// There is no account, no console, and no transfer. One advertised
		// action would be one more than exists.
		assert.equal(TTL_SH_CLAIM_ACTION_COUNT, 0);
		assert.equal(TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.claimActionCount, 0);
		assert.equal(TTL_SH_RESOURCE_SEMANTICS.claimActionCount, 0);
	});

	it("declares the none-expire claim mode and maps it to no ownership transition", () => {
		assert.equal(TTL_SH_CLAIM_MODE, "none-expire");
		assert.equal(TTL_SH_RESOURCE_SEMANTICS.claimMode, "none-expire");
		assert.equal(TTL_SH_RESOURCE_SEMANTICS.ownershipTransitionMode, "none");
		assert.equal(
			TTL_SH_RESOURCE_SEMANTICS.structuredCapabilities.claimMode,
			"none-expire",
		);
	});

	it("declares expiry as the only cleanup policy", () => {
		assert.equal(TTL_SH_CLEANUP_POLICY, "retain-until-provider-expiry");
		assert.equal(
			TTL_SH_RESOURCE_SEMANTICS.cleanupPolicy,
			"retain-until-provider-expiry",
		);
		assert.equal(
			TTL_SH_RESOURCE_SEMANTICS.structuredCapabilities.cleanup,
			"expiry",
		);
		// No delete endpoint exists, so revocation is not offered.
		assert.equal(TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.supportsRevocation, false);
	});

	it("declares the public-anonymous bootstrap class", () => {
		assert.equal(TTL_SH_RESOURCE_SEMANTICS.bootstrapClass, "public-anonymous");
		assert.equal(
			TTL_SH_RESOURCE_SEMANTICS.structuredCapabilities.bootstrap,
			"public-anonymous",
		);
	});

	it("never advertises durability, deletion, or privacy", () => {
		const capabilities = TTL_SH_RESOURCE_SEMANTICS.structuredCapabilities;
		assert.equal(capabilities.durable, false);
		assert.equal(capabilities.deleteOnDemand, false);
		assert.equal(capabilities.publiclyReadable, true);
		assert.equal(capabilities.authenticated, false);
		assert.equal(capabilities.maxTtlMinutes, 24 * 60);
	});

	it("says the data is discarded and no authority survives", () => {
		assert.equal(
			TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.continuity.data,
			"discarded",
		);
		assert.equal(
			TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.continuity.credentials,
			"not-applicable",
		);
		assert.equal(
			TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.creatorAuthorityAfterClaim,
			"absent",
		);
	});

	it("sponsors nothing and exports nothing", () => {
		assert.equal(
			TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.sponsorExposureMinorUnits,
			0,
		);
		assert.equal(TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.supportsExport, false);
		assert.deepEqual(TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.migrationProfiles, []);
	});
});

describe("the capability profile it implements", () => {
	it("parses, and refines content-addressed storage rather than hosting", () => {
		const parsed = parseCapabilityProfile(TTL_SH_ARTIFACT_TRANSPORT_PROFILE);

		assert.equal(parsed.id, TTL_SH_ARTIFACT_TRANSPORT_PROFILE_ID);
		assert.equal(parsed.primitive, "bucket");
		assert.deepEqual([...parsed.refines], ["bucket.content-addressed/v1"]);
	});

	it("registers alongside the standard profiles and satisfies its ancestor", () => {
		const registry = createCapabilityProfileRegistry([
			...STANDARD_CAPABILITY_PROFILES,
			TTL_SH_ARTIFACT_TRANSPORT_PROFILE,
		]);

		assert.equal(
			registry.satisfies(
				TTL_SH_ARTIFACT_TRANSPORT_PROFILE_ID,
				"bucket.object/v1",
			),
			true,
		);
		// A transport is not a place to keep anything, and the profile graph
		// must not let a hosting requirement resolve to it.
		assert.equal(
			registry.satisfies(TTL_SH_ARTIFACT_TRANSPORT_PROFILE_ID, "web.hosted/v1"),
			false,
		);
		assert.equal(
			registry.satisfies(
				TTL_SH_ARTIFACT_TRANSPORT_PROFILE_ID,
				"data.relational/v1",
			),
			false,
		);
	});

	it("claims exactly one profile, natively, with a scoped conformance ref", () => {
		const implementations =
			TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.implementsProfiles;
		assert.equal(implementations.length, 1);
		const implementation = implementations[0];
		assert.ok(implementation !== undefined);
		assert.equal(implementation.realization, "native");
		assert.match(
			implementation.conformanceRef,
			/offline-fixtures@2026-08-08$/u,
		);
	});

	it("carries a parseable profile id", () => {
		assert.equal(
			parseProfileId(TTL_SH_ARTIFACT_TRANSPORT_PROFILE_ID).primitive,
			"bucket",
		);
	});
});

describe("evidence and shape", () => {
	it("is structurally a SelectionCandidate", () => {
		const candidate: SelectionCandidate = TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE;
		assert.equal(candidate.definitionId, TTL_SH_DEFINITION_ID);
		assert.equal(candidate.providerId, "ttl-sh");
	});

	it("dates every source and marks the ones nobody re-fetched", () => {
		assert.ok(TTL_SH_SOURCE_REFS.length >= 2);
		for (const source of TTL_SH_SOURCE_REFS) {
			assert.equal(source.checkedAt, TTL_SH_EVIDENCE_CHECKED_AT);
			assert.match(source.url, /^https:\/\//u);
			assert.ok(source.verified === true || source.verified === false);
		}
		// The landing page was fetched on the checked date, which is where the
		// 24-hour ceiling and the zero-credential rule come from.
		assert.equal(
			TTL_SH_SOURCE_REFS.find((source) => source.url === "https://ttl.sh")
				?.verified,
			true,
		);
		// The implementation repository was not re-read, and the definition says so
		// rather than implying a verification nobody performed.
		assert.equal(
			TTL_SH_SOURCE_REFS.find(
				(source) => source.url === "https://github.com/replicatedhq/ttl.sh",
			)?.verified,
			false,
		);
	});

	it("expires its evidence rather than trusting it forever", () => {
		const expires = TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.evidenceExpiresAtMs;
		assert.ok(expires !== undefined);
		assert.ok(expires > Date.parse(TTL_SH_EVIDENCE_CHECKED_AT));
	});

	it("carries an unsigned variant for a catalog owner who has not signed it", () => {
		assert.equal(
			createTtlShArtifactTransportCandidate({ evidenceSignatureValid: false })
				.evidenceSignatureValid,
			false,
		);
	});

	it("only carries the OCI runtime model, because that is what it transports", () => {
		assert.deepEqual(
			[...TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE.runtimeModels],
			["oci"],
		);
	});

	it("matches the legacy bucket port and reports missing features honestly", () => {
		assert.equal(
			TTL_SH_RESOURCE_DEFINITION.satisfies({
				port: "bucket",
				features: ["ephemeral"],
			}).kind,
			"full",
		);
		assert.equal(
			TTL_SH_RESOURCE_DEFINITION.satisfies({ port: "data" }).kind,
			"none",
		);
		const partial = TTL_SH_RESOURCE_DEFINITION.satisfies({
			port: "bucket",
			features: ["durable"],
		});
		assert.equal(partial.kind, "partial");
		assert.deepEqual(partial.missing, ["durable"]);
	});

	it("names an executor, without which selection would refuse it anyway", () => {
		assert.ok(TTL_SH_RESOURCE_SEMANTICS.executorRef.length > 0);
		assert.equal(
			TTL_SH_RESOURCE_SEMANTICS.schemaVersion,
			"hobo.resource-definition/vNext",
		);
	});

	it("documents the remediation for an expired lease and for the absent delete endpoint", () => {
		const codes = TTL_SH_RESOURCE_SEMANTICS.remediation.map(
			(hint) => hint.code,
		);
		assert.ok(codes.includes("LEASE_EXPIRED"));
		assert.ok(codes.includes("CLEANUP_FAILED"));
		assert.ok(codes.includes("GUESSABLE_ARTIFACT_NAME"));
	});
});

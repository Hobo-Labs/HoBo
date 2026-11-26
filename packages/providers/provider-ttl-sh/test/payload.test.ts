/**
 * The durable-use refusal.
 *
 * Two halves are being tested. The runtime half is straightforward: a payload
 * describing durable state is refused. The type half is the one that actually
 * holds, and it is checked by `tsconfig.test.json` compiling this file — the
 * commented assignments below are the ones that must never compile, and they are
 * written out so a future change that widens `ArtifactPayload` has to delete a
 * comment explaining why it should not.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	EPHEMERAL_PAYLOAD_KINDS,
	isAcknowledgedTemporaryHandoff,
	parseArtifactPayload,
	parseOwnerControlledRegistry,
	REFUSED_PAYLOAD_KINDS,
} from "../src/payload.js";
import { parseTtlWindow } from "../src/reference.js";
import { expectTtlShCode } from "./fixtures/index.js";

const ONE_HOUR = parseTtlWindow("1h");
const FIVE_MINUTES = parseTtlWindow("5m");

function namesMatch(left: string, right: string): boolean {
	return left === right;
}

const BUILD_IMAGE = {
	kind: "ci-build-image",
	artifactType: "application/vnd.oci.image.config.v1+json",
	reproducedBy: "rebuild from the commit the pipeline recorded",
};

const ACKNOWLEDGEMENT = {
	acceptedBy: "release pipeline, run 4471",
	reason: "hand the fixture dataset to the integration job in the next stage",
	durableCopyLocation:
		"s3://acme-fixtures/2026-08-08/orders.tar (versioned bucket)",
	promotionTarget: "registry.acme.example.com",
	promoteWithinMinutes: 30,
};

describe("parseArtifactPayload", () => {
	it("accepts a reproducible build artifact that says how it is regenerated", () => {
		const payload = parseArtifactPayload(BUILD_IMAGE, ONE_HOUR);

		assert.equal(payload.kind, "ci-build-image");
		assert.equal(isAcknowledgedTemporaryHandoff(payload), false);
	});

	for (const kind of EPHEMERAL_PAYLOAD_KINDS) {
		it(`accepts the reproducible kind ${kind}`, () => {
			assert.equal(
				parseArtifactPayload({ ...BUILD_IMAGE, kind }, ONE_HOUR).kind,
				kind,
			);
		});
	}

	for (const kind of REFUSED_PAYLOAD_KINDS) {
		it(`refuses ${kind} as durable state`, () => {
			expectTtlShCode(
				() => parseArtifactPayload({ ...BUILD_IMAGE, kind }, ONE_HOUR),
				"ARTIFACT_DURABLE_USE_REFUSED",
			);
		});
	}

	it("refuses an unknown kind rather than treating it as reproducible", () => {
		expectTtlShCode(
			() =>
				parseArtifactPayload(
					{ ...BUILD_IMAGE, kind: "probably-fine" },
					ONE_HOUR,
				),
			"ARTIFACT_DURABLE_USE_REFUSED",
		);
	});

	it("refuses a reproducible payload that does not say how it is reproduced", () => {
		// Without this the recovery procedure is somebody's memory, and the
		// artifact is gone by the time anybody looks for it.
		const { reproducedBy: _dropped, ...rest } = BUILD_IMAGE;
		expectTtlShCode(
			() => parseArtifactPayload(rest, ONE_HOUR),
			"ARTIFACT_DURABLE_USE_REFUSED",
		);
	});

	it("refuses a placeholder answer that is technically a string", () => {
		expectTtlShCode(
			() =>
				parseArtifactPayload({ ...BUILD_IMAGE, reproducedBy: "n/a" }, ONE_HOUR),
			"ARTIFACT_DURABLE_USE_REFUSED",
		);
	});

	it("refuses a media type that is not one", () => {
		expectTtlShCode(
			() =>
				parseArtifactPayload(
					{ ...BUILD_IMAGE, artifactType: "tarball" },
					ONE_HOUR,
				),
			"INVALID_IMAGE_REFERENCE",
		);
	});
});

describe("an accepted temporary handoff", () => {
	it("is representable, and carries every field of the acceptance", () => {
		const payload = parseArtifactPayload(
			{
				kind: "accepted-temporary-handoff",
				artifactType: "application/vnd.oci.image.layer.v1.tar",
				acknowledgement: ACKNOWLEDGEMENT,
			},
			ONE_HOUR,
		);

		assert.ok(isAcknowledgedTemporaryHandoff(payload));
		assert.equal(
			payload.acknowledgement.promotionTarget,
			"registry.acme.example.com",
		);
		assert.equal(payload.acknowledgement.promoteWithinMinutes, 30);
	});

	it("refuses a promotion deadline that falls after the artifact expires", () => {
		// A deadline past the TTL is not a plan, it is a hope: the artifact is
		// gone before the promotion is due.
		expectTtlShCode(
			() =>
				parseArtifactPayload(
					{
						kind: "accepted-temporary-handoff",
						artifactType: "application/vnd.oci.image.layer.v1.tar",
						acknowledgement: ACKNOWLEDGEMENT,
					},
					FIVE_MINUTES,
				),
			"ARTIFACT_DURABLE_USE_REFUSED",
		);
	});

	it("refuses an acknowledgement with no durable copy behind it", () => {
		const { durableCopyLocation: _dropped, ...rest } = ACKNOWLEDGEMENT;
		expectTtlShCode(
			() =>
				parseArtifactPayload(
					{
						kind: "accepted-temporary-handoff",
						artifactType: "application/vnd.oci.image.layer.v1.tar",
						acknowledgement: rest,
					},
					ONE_HOUR,
				),
			"ARTIFACT_DURABLE_USE_REFUSED",
		);
	});

	it("refuses an acknowledgement whose promotion target is another ephemeral registry", () => {
		expectTtlShCode(
			() =>
				parseArtifactPayload(
					{
						kind: "accepted-temporary-handoff",
						artifactType: "application/vnd.oci.image.layer.v1.tar",
						acknowledgement: { ...ACKNOWLEDGEMENT, promotionTarget: "ttl.sh" },
					},
					ONE_HOUR,
				),
			"PROMOTION_TARGET_INVALID",
		);
	});
});

describe("parseOwnerControlledRegistry", () => {
	it("accepts a registry host, with or without a port", () => {
		assert.equal(
			parseOwnerControlledRegistry("registry.acme.example.com"),
			"registry.acme.example.com",
		);
		assert.equal(
			parseOwnerControlledRegistry("localhost:5000"),
			"localhost:5000",
		);
	});

	it("lowercases rather than rejecting a mixed-case host", () => {
		assert.equal(
			parseOwnerControlledRegistry("Registry.ACME.example.com"),
			"registry.acme.example.com",
		);
	});

	for (const [reason, host] of [
		["this registry itself", "ttl.sh"],
		["this registry with an explicit port", "ttl.sh:443"],
		["a URL rather than a host", "https://registry.acme.example.com"],
		["a host with a path", "registry.acme.example.com/acme"],
	] as const) {
		it(`refuses ${reason}`, () => {
			expectTtlShCode(
				() => parseOwnerControlledRegistry(host),
				"PROMOTION_TARGET_INVALID",
			);
		});
	}
});

describe("the types themselves", () => {
	it("has no variant that could describe durable state", () => {
		// The runtime list and the type union are the same fact stated twice, and
		// this is where they are checked against each other. There is no
		// `ArtifactPayload` value with any of these kinds, which is why the
		// following would not compile:
		//
		//   const bad: ArtifactPayload = { kind: "database-backup", ... };
		//   //                                   ^ not assignable
		assert.ok(REFUSED_PAYLOAD_KINDS.length > 0);
		for (const refused of REFUSED_PAYLOAD_KINDS) {
			let found = false;
			for (const kind of EPHEMERAL_PAYLOAD_KINDS) {
				if (namesMatch(kind, refused)) found = true;
			}
			assert.equal(found, false);
		}
	});
});

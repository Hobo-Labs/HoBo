import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	contentAddressedNameFor,
	createTtlShImageReference,
	expiresAtMs,
	manifestPath,
	parseArtifactDigest,
	parseArtifactName,
	parseTtlShImageReference,
	parseTtlWindow,
	referenceForDigest,
	TTL_SH_MAX_TTL_MINUTES,
} from "../src/reference.js";
import {
	expectTtlShCode,
	expectTtlShProviderError,
	FAKE_CONTENT_NAME,
	FAKE_DIGEST,
	FAKE_UUID_NAME,
	NOW_MS,
} from "./fixtures/index.js";

describe("parseTtlShImageReference", () => {
	it("parses a UUID-named reference", () => {
		const reference = parseTtlShImageReference(`ttl.sh/${FAKE_UUID_NAME}:1h`);

		assert.equal(reference.host, "ttl.sh");
		assert.equal(reference.name, FAKE_UUID_NAME);
		assert.equal(reference.nameKind, "uuid");
		assert.equal(reference.ttl.minutes, 60);
		assert.equal(reference.pullReference, `ttl.sh/${FAKE_UUID_NAME}:1h`);
	});

	it("parses a content-addressed reference", () => {
		const reference = parseTtlShImageReference(
			`ttl.sh/${FAKE_CONTENT_NAME}:30m`,
		);

		assert.equal(reference.nameKind, "content-addressed");
		assert.equal(reference.ttl.minutes, 30);
	});

	for (const [reason, input] of [
		["another registry", `docker.io/${FAKE_UUID_NAME}:1h`],
		["a lookalike host", `ttl.sh.evil.example.com/${FAKE_UUID_NAME}:1h`],
		["a registry subdomain", `registry.ttl.sh/${FAKE_UUID_NAME}:1h`],
	] as const) {
		it(`refuses ${reason}`, () => {
			// The push carries no credential, so a wrong host does not fail —
			// it succeeds somewhere that keeps the layers.
			expectTtlShCode(
				() => parseTtlShImageReference(input),
				"TRANSPORT_NOT_ALLOWED",
			);
		});
	}

	for (const [reason, input] of [
		["a scheme", `https://ttl.sh/${FAKE_UUID_NAME}:1h`],
		["a nested repository path", `ttl.sh/team/${FAKE_UUID_NAME}:1h`],
		["a missing TTL tag", `ttl.sh/${FAKE_UUID_NAME}`],
		["an empty TTL tag", `ttl.sh/${FAKE_UUID_NAME}:`],
		[
			"a digest pin, which cannot be pushed to",
			`ttl.sh/${FAKE_UUID_NAME}@${FAKE_DIGEST}`,
		],
		["uppercase", `TTL.SH/${FAKE_UUID_NAME}:1h`],
		["surrounding whitespace", ` ttl.sh/${FAKE_UUID_NAME}:1h `],
		["an empty string", ""],
	] as const) {
		it(`refuses ${reason}`, () => {
			expectTtlShProviderError(() => parseTtlShImageReference(input));
		});
	}

	it("refuses a reference longer than the bound", () => {
		expectTtlShCode(
			() => parseTtlShImageReference(`ttl.sh/${"a".repeat(200)}:1h`),
			"INVALID_IMAGE_REFERENCE",
		);
	});
});

describe("parseArtifactName", () => {
	for (const guessable of [
		"my-app",
		"hobo-build",
		"staging",
		"main",
		"release-2026-08-08",
		"acme-invoices-prod",
	]) {
		it(`refuses the guessable name ${JSON.stringify(guessable)}`, () => {
			// ttl.sh is unauthenticated in both directions: the name is the
			// only thing between the image and whoever tries it.
			expectTtlShCode(
				() => parseArtifactName(guessable),
				"GUESSABLE_ARTIFACT_NAME",
			);
		});
	}

	it("refuses a UUID with an uppercase digit, which would resolve elsewhere", () => {
		expectTtlShCode(
			() => parseArtifactName(FAKE_UUID_NAME.toUpperCase()),
			"GUESSABLE_ARTIFACT_NAME",
		);
	});

	it("refuses a name that only looks content-addressed", () => {
		expectTtlShCode(
			() => parseArtifactName("sha256-deadbeef"),
			"GUESSABLE_ARTIFACT_NAME",
		);
	});

	it("accepts a minted UUID and a full content-addressed name", () => {
		assert.equal(parseArtifactName(FAKE_UUID_NAME).nameKind, "uuid");
		assert.equal(
			parseArtifactName(FAKE_CONTENT_NAME).nameKind,
			"content-addressed",
		);
	});
});

describe("parseTtlWindow", () => {
	it("normalizes hours into minutes", () => {
		assert.equal(parseTtlWindow("24h").minutes, TTL_SH_MAX_TTL_MINUTES);
		assert.equal(parseTtlWindow("1m").minutes, 1);
		assert.equal(parseTtlWindow("90m").text, "90m");
	});

	it("refuses a TTL over the documented 24h ceiling", () => {
		// Refused rather than clamped: a caller planning around 48 hours is
		// planning around a lease that will not exist.
		expectTtlShCode(() => parseTtlWindow("25h"), "TTL_OUT_OF_RANGE");
		expectTtlShCode(() => parseTtlWindow("1441m"), "TTL_OUT_OF_RANGE");
	});

	it("refuses an undocumented unit rather than translating it", () => {
		expectTtlShCode(() => parseTtlWindow("1d"), "TTL_OUT_OF_RANGE");
		expectTtlShCode(() => parseTtlWindow("30s"), "TTL_OUT_OF_RANGE");
	});

	it("refuses a zero, negative, or non-numeric TTL", () => {
		expectTtlShCode(() => parseTtlWindow("0m"), "TTL_OUT_OF_RANGE");
		expectTtlShCode(() => parseTtlWindow("-1h"), "TTL_OUT_OF_RANGE");
		expectTtlShCode(() => parseTtlWindow("h"), "TTL_OUT_OF_RANGE");
		expectTtlShCode(() => parseTtlWindow("01h"), "TTL_OUT_OF_RANGE");
	});
});

describe("digests and derived references", () => {
	it("parses a well-formed digest and refuses a malformed one", () => {
		assert.equal(parseArtifactDigest(FAKE_DIGEST), FAKE_DIGEST);
		expectTtlShCode(
			() => parseArtifactDigest("sha512:0000"),
			"INVALID_IMAGE_REFERENCE",
		);
	});

	it("derives a content-addressed name that is a pure function of the digest", () => {
		const digest = parseArtifactDigest(FAKE_DIGEST);
		assert.equal(contentAddressedNameFor(digest), FAKE_CONTENT_NAME);
		assert.equal(
			referenceForDigest(digest, "2h").pullReference,
			`ttl.sh/${FAKE_CONTENT_NAME}:2h`,
		);
	});

	it("builds a reference through the same parser as a raw string", () => {
		assert.deepEqual(
			createTtlShImageReference({ name: FAKE_UUID_NAME, ttl: "1h" }),
			parseTtlShImageReference(`ttl.sh/${FAKE_UUID_NAME}:1h`),
		);
	});
});

describe("expiry", () => {
	it("computes expiry from the push instant and the TTL", () => {
		const reference = createTtlShImageReference({
			name: FAKE_UUID_NAME,
			ttl: "90m",
		});
		assert.equal(expiresAtMs(reference, NOW_MS), NOW_MS + 90 * 60_000);
	});

	it("refuses a nonsensical push instant", () => {
		const reference = createTtlShImageReference({
			name: FAKE_UUID_NAME,
			ttl: "1h",
		});
		expectTtlShCode(() => expiresAtMs(reference, 0), "INVALID_IMAGE_REFERENCE");
	});

	it("addresses the manifest under the /v2/ API surface", () => {
		assert.equal(
			manifestPath(
				createTtlShImageReference({ name: FAKE_UUID_NAME, ttl: "1h" }),
			),
			`/v2/${FAKE_UUID_NAME}/manifests/1h`,
		);
	});
});

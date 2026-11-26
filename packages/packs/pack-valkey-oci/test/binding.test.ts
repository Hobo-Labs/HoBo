import assert from "node:assert/strict";
import { PackError } from "@hobo/pack-framework";
import { describe, it } from "vitest";

import {
	buildValkeyBinding,
	VALKEY_BINDING_PROFILE,
	valkeyRetentionSemantics,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import {
	AUTH_REF,
	CERTIFICATE_REF,
	verifiedOtherPack,
	verifiedValkeyPack,
} from "./harness.js";

const manifest = verifiedValkeyPack();

const DURABLE = valkeyRetentionSemantics({
	durabilityMode: "aof-everysec",
	evictionPolicy: "noeviction",
});

const CACHE = valkeyRetentionSemantics({
	durabilityMode: "none",
	evictionPolicy: "allkeys-lru",
});

function binding(
	overrides: Partial<Parameters<typeof buildValkeyBinding>[1]> = {},
) {
	return buildValkeyBinding(manifest, {
		bindingId: "binding-valkey-1",
		resourceRef: "resource:yard-1/cache-main",
		host: "cache-main.yard-1.hobo.test",
		credentialRef: AUTH_REF,
		tls: false,
		retention: DURABLE,
		producerEvidenceRef: "evidence:pack/valkey/cache-main",
		...overrides,
	});
}

describe("buildValkeyBinding", () => {
	it("produces binding.redis-protocol/v1 with a locator, not a URL", () => {
		const result = binding();
		assert.equal(result.bindingProfileRef, VALKEY_BINDING_PROFILE);
		assert.equal(result.capabilityProfileRef, "kv.redis-compatible/v1");
		assert.equal(result.credentialRef, AUTH_REF);
		const endpoint = result.endpoints[0];
		assert.equal(endpoint?.addressRef.host, "cache-main.yard-1.hobo.test");
		assert.equal(endpoint?.addressRef.port, 6379);
		// A `redis://user:pass@host` string is a credential with a hostname
		// attached, so the address field cannot hold one.
		assert.ok(!endpoint?.addressRef.host.includes("@"));
		assert.ok(!endpoint?.addressRef.host.includes(":"));
	});

	it("names no provider, because there is no vendor product here", () => {
		assert.equal(binding().provider, undefined);
	});

	it("traces back to the digest that produced it", () => {
		assert.equal(
			binding().metadataRefs?.imageDigest,
			manifest.selectedImage.digest,
		);
		assert.equal(binding().metadataRefs?.packId, "pack.valkey.oci/v1");
	});

	it("publishes the retention facts a consumer would otherwise have to guess", () => {
		const durable = binding().metadataRefs;
		assert.equal(durable?.durabilityMode, "aof-everysec");
		assert.equal(durable?.worstCaseLossMs, "1000");
		assert.equal(durable?.keyLossPossible, "false");

		const cache = binding({ retention: CACHE }).metadataRefs;
		assert.equal(cache?.durabilityMode, "none");
		assert.equal(cache?.worstCaseLossMs, "entire-keyspace");
		assert.equal(cache?.keyLossPossible, "true");
	});

	it("states that it carries no delivery guarantee", () => {
		// Pub/sub and list commands are present in the server; neither is a
		// queue, and a consumer reading this binding should not infer one.
		assert.equal(binding().metadataRefs?.deliveryGuarantees, "none");
	});

	it("refuses TLS without the certificate to verify against", () => {
		assert.throws(
			() => binding({ tls: true }),
			(error: JsonValue) =>
				error instanceof PackError &&
				error.code === "PACK_CONFIGURATION_INVALID",
		);
		const secured = binding({ tls: true, certificateRef: CERTIFICATE_REF });
		assert.equal(secured.certificateRef, CERTIFICATE_REF);
		assert.equal(secured.endpoints[0]?.addressRef.tls, true);
	});

	it("rejects a database index outside the SELECT space", () => {
		assert.throws(
			() => binding({ database: 300 }),
			(error: JsonValue) =>
				error instanceof PackError &&
				error.code === "PACK_CONFIGURATION_INVALID",
		);
	});

	it("does not claim an expiry nothing enforces, but supports rotation", () => {
		const result = binding();
		assert.equal(result.renewable, false);
		assert.equal(result.rotationSupported, true);
		assert.equal(result.revocationSupported, true);
	});

	it("refuses to describe a binding for a different pack", () => {
		// A genuinely different pack, verified through the real path rather than
		// a cast: the guard has to reject a manifest the type system accepts.
		const other = verifiedOtherPack();
		assert.throws(
			() =>
				buildValkeyBinding(other, {
					bindingId: "binding-valkey-1",
					resourceRef: "resource:yard-1/cache-main",
					host: "cache-main.yard-1.hobo.test",
					credentialRef: AUTH_REF,
					tls: false,
					retention: DURABLE,
					producerEvidenceRef: "evidence:pack/valkey/cache-main",
				}),
			(error: JsonValue) =>
				error instanceof PackError && error.code === "PACK_MANIFEST_INVALID",
		);
	});
});

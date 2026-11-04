import assert from "node:assert/strict";
import { redactSecretRef } from "@hobo/bindings";
import { PackError } from "@hobo/pack-framework";
import { describe, it } from "vitest";

import {
	buildPostgresBinding,
	POSTGRES_BINDING_PROFILE,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import {
	CERTIFICATE_REF,
	SUPERUSER_REF,
	verifiedPostgresPack,
} from "./harness.js";

const manifest = verifiedPostgresPack();

const INPUT = {
	bindingId: "binding-pg-main",
	resourceRef: "camp-demo/pg-main",
	host: "pg-main.camp-demo.hobo.localhost",
	database: "app",
	role: "app_owner",
	credentialRef: SUPERUSER_REF,
	tls: false,
	producerEvidenceRef: "hobo.evidence/pack.postgres.oci@2026-08-08",
};

describe("buildPostgresBinding", () => {
	it("produces binding.postgresql/v1 with the credential as a locator", () => {
		const binding = buildPostgresBinding(manifest, INPUT);
		assert.equal(binding.bindingProfileRef, POSTGRES_BINDING_PROFILE);
		assert.equal(binding.capabilityProfileRef, "data.postgres/v1");
		assert.equal(binding.credentialRef, SUPERUSER_REF);
		assert.equal(binding.endpoints[0]?.protocol, "postgresql");
		assert.equal(binding.endpoints[0]?.addressRef.port, 5432);
	});

	it("names no provider, because there is no vendor product behind it", () => {
		const binding = buildPostgresBinding(manifest, INPUT);
		assert.equal(binding.provider, undefined);
	});

	it("records the pinned digest so a binding is traceable to the bytes that served it", () => {
		const binding = buildPostgresBinding(manifest, INPUT);
		assert.equal(
			binding.metadataRefs?.imageDigest,
			manifest.selectedImage.digest,
		);
	});

	it("refuses a host that carries embedded credentials", () => {
		assert.throws(() =>
			buildPostgresBinding(manifest, {
				...INPUT,
				host: "app:hunter2@pg-main.internal",
			}),
		);
	});

	it("refuses to claim TLS without naming the certificate to verify against", () => {
		assert.throws(
			() => buildPostgresBinding(manifest, { ...INPUT, tls: true }),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "PACK_CONFIGURATION_INVALID");
				return true;
			},
		);
	});

	it("accepts a TLS binding that references its certificate", () => {
		const binding = buildPostgresBinding(manifest, {
			...INPUT,
			tls: true,
			certificateRef: CERTIFICATE_REF,
		});
		assert.equal(binding.endpoints[0]?.addressRef.tls, true);
		assert.equal(binding.certificateRef, CERTIFICATE_REF);
	});

	it("redacts to something safe to log", () => {
		const binding = buildPostgresBinding(manifest, INPUT);
		const redacted = redactSecretRef(binding.credentialRef ?? "");
		assert.ok(!redacted.includes("superuser"));
	});

	it("does not claim a renewable credential nothing renews", () => {
		const binding = buildPostgresBinding(manifest, INPUT);
		assert.equal(binding.renewable, false);
		assert.equal(binding.rotationSupported, true);
	});
});

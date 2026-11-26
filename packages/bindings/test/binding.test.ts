import { describe, expect, it } from "vitest";

import {
	type CapabilityBindingInput,
	createConnectivityRegistry,
	parseCapabilityBinding,
	parseSecretRef,
	STANDARD_CONNECTIVITY,
} from "../src/index.js";

const base: CapabilityBindingInput = {
	schemaVersion: "hobo.capability-binding/v1",
	id: "binding-01",
	resourceRef: "resource://yard/neon/db",
	capabilityProfileRef: "data.postgres/v1",
	bindingProfileRef: "binding.postgresql/v1",
	type: "postgresql",
	provider: "neon",
	endpoints: [
		{
			protocol: "postgresql",
			addressRef: {
				host: "ep-cool.us-east-2.aws.neon.tech",
				port: 5432,
				tls: true,
			},
			role: "primary",
		},
	],
	credentialRef: "vault://tenant/neon/db#connection",
	renewable: true,
	rotationSupported: true,
	revocationSupported: true,
	producerEvidenceRef: "evidence://neon/claimable-postgres/v1",
};

describe("capability binding", () => {
	it("parses a postgres binding with a referenced credential", () => {
		const binding = parseCapabilityBinding(base, parseSecretRef);
		expect(binding.credentialRef).toBe("vault://tenant/neon/db#connection");
		expect(binding.endpoints[0]?.addressRef.tls).toBe(true);
	});

	it("keeps credential material out of the serialized binding", () => {
		const binding = parseCapabilityBinding(base, parseSecretRef);
		const serialized = JSON.stringify(binding);
		expect(serialized).not.toMatch(/postgresql:\/\//u);
		expect(serialized).not.toContain("password");
	});

	it("rejects a connection string smuggled into the endpoint host", () => {
		expect(() =>
			parseCapabilityBinding(
				{
					...base,
					endpoints: [
						{
							protocol: "postgresql",
							addressRef: { host: "user:pw@db.example.com", tls: true },
						},
					],
				},
				parseSecretRef,
			),
		).toThrow(/bare hostname/u);
	});

	it("rejects a plaintext credential in credentialRef", () => {
		// `parseCapabilityBinding` refuses for a dozen unrelated reasons (bad
		// schemaVersion, missing profile ref, out-of-range port). A bare
		// `.toThrow()` here would have gone green on any of them, so it did not
		// establish that the *secret-locator* rule is what rejects a
		// connection string — the one property this test is named for.
		let thrown: unknown;
		try {
			parseCapabilityBinding(
				{ ...base, credentialRef: "postgresql://user:pw@host:5432/db" },
				parseSecretRef,
			);
		} catch (cause) {
			thrown = cause;
		}
		expect(thrown, "plaintext credential was admitted").toBeInstanceOf(Error);
		// SAFETY: the preceding assertion proves the caught value is an Error.
		const error = thrown as Error & { code?: unknown };
		expect(error.name).toBe("SecretRefError");
		expect(error.code).toBe("SECRET_REFERENCE_EMBEDS_VALUE");
		expect(error.message).toBe(
			"value looks like a plaintext credential, not a secret locator; deposit it into secret custody and reference it instead",
		);
	});

	it("rejects a binding with no endpoints", () => {
		expect(() =>
			parseCapabilityBinding({ ...base, endpoints: [] }, parseSecretRef),
		).toThrow(/no endpoints/u);
	});

	it("rejects an out-of-range port", () => {
		expect(() =>
			parseCapabilityBinding(
				{
					...base,
					endpoints: [
						{
							protocol: "postgresql",
							addressRef: { host: "db.example.com", port: 0, tls: true },
						},
					],
				},
				parseSecretRef,
			),
		).toThrow(/port is out of range/u);
	});

	it("canonically orders endpoints so equivalent bindings compare equal", () => {
		const pooled = {
			protocol: "postgresql" as const,
			addressRef: { host: "ep-cool-pooler.neon.tech", port: 5432, tls: true },
			role: "pooled",
		};
		// SAFETY: base declares one primary endpoint and the test does not mutate it.
		const primary = base.endpoints[0] as (typeof base.endpoints)[number];
		const a = parseCapabilityBinding(
			{ ...base, endpoints: [primary, pooled] },
			parseSecretRef,
		);
		const b = parseCapabilityBinding(
			{ ...base, endpoints: [pooled, primary] },
			parseSecretRef,
		);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("connectivity resolution", () => {
	const registry = createConnectivityRegistry(STANDARD_CONNECTIVITY);

	it("resolves Hyperdrive for a Worker consuming a postgres binding", () => {
		const resolved = registry.resolve({
			bindingProfileRef: "binding.postgresql/v1",
			runtimeModel: "serverless_faas",
			providerId: "cloudflare",
		});
		expect(resolved.map((entry) => entry.id)).toEqual([
			"cloudflare.postgres.hyperdrive/v1",
			"cloudflare.postgres.neon-serverless/v1",
		]);
	});

	it("treats Hyperdrive as connectivity, not as a database", () => {
		const hyperdrive = STANDARD_CONNECTIVITY.find(
			(entry) => entry.id === "cloudflare.postgres.hyperdrive/v1",
		);
		expect(hyperdrive?.projection).toBe("provider-binding");
		expect(hyperdrive?.consumesBindingProfiles).toEqual([
			"binding.postgresql/v1",
		]);
	});

	it("does not offer a Cloudflare projection inside a Vercel yard", () => {
		const resolved = registry.resolve({
			bindingProfileRef: "binding.postgresql/v1",
			runtimeModel: "serverless_faas",
			providerId: "vercel",
		});
		expect(resolved.map((entry) => entry.id)).toEqual([
			"vercel.postgres.environment-ref/v1",
		]);
	});

	it("falls back to service-binding files for an OCI workload", () => {
		const resolved = registry.resolve({
			bindingProfileRef: "binding.postgresql/v1",
			runtimeModel: "oci",
		});
		expect(resolved.map((entry) => entry.id)).toEqual([
			"oci.service-binding-files/v1",
		]);
	});

	it("returns nothing when no projection exists for the runtime", () => {
		expect(
			registry.resolve({
				bindingProfileRef: "binding.s3/v1",
				runtimeModel: "vm_iaas",
			}),
		).toEqual([]);
	});

	it("orders results deterministically regardless of registration order", () => {
		const reversed = createConnectivityRegistry(
			[...STANDARD_CONNECTIVITY].reverse(),
		);
		expect(reversed.list().map((e) => e.id)).toEqual(
			registry.list().map((e) => e.id),
		);
	});

	it("rejects duplicate implementation ids", () => {
		expect(() =>
			createConnectivityRegistry([
				// SAFETY: duplicate entries are intentionally supplied to test rejection.
				STANDARD_CONNECTIVITY[0] as never,
				// SAFETY: duplicate entries are intentionally supplied to test rejection.
				STANDARD_CONNECTIVITY[0] as never,
			]),
		).toThrow(/duplicate connectivity implementation/u);
	});
});

// Signed bundles load only after @hobo/registry verifies them; any tamper,
// missing verifier or foreign signer is a typed refusal.
import { createRuntimeLocalComponentHost } from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import { componentizeResolver } from "../src/build/index.js";
import { defineResolverGuest, ok, outcome } from "../src/guest/index.js";
import {
	createGuestModuleEngine,
	loadResolverComponent,
	ResolverComponentError,
	resolverRegistryManifest,
	verifyResolverComponentBundle,
} from "../src/index.js";
import { manifestJson } from "./fixtures.js";
import {
	attest,
	build,
	Credentials,
	issuer,
	publicDns,
	signedBundle,
	verifierFor,
} from "./harness.js";

async function refusalOf(
	run: Promise<unknown>,
): Promise<ResolverComponentError> {
	try {
		await run;
	} catch (error) {
		if (error instanceof ResolverComponentError) return error;
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("signed component bundles (verified via @hobo/registry)", () => {
	it("verifies a correctly signed bundle and binds both digests", async () => {
		const signer = issuer();
		const built = build(manifestJson(), "bundle-ok");
		const verified = await verifyResolverComponentBundle(
			await signedBundle(built, signer),
			verifierFor(signer),
		);
		expect(verified.wasmDigest).toBe(built.manifest.wasmDigest);
		expect(verified.registryDigest).toBe(built.registryDigest);
		expect(verified.signedBy).toBe("spiffe://hobo/component-publisher");
	});

	it("refuses to load without a verifier (unverified is never a pass)", async () => {
		const built = build(manifestJson(), "bundle-unverified");
		const error = await refusalOf(
			verifyResolverComponentBundle(
				await signedBundle(built, issuer()),
				undefined,
			),
		);
		expect(error.componentCode).toBe("component.bundle-unverified");
	});

	it("refuses a foreign signer", async () => {
		const built = build(manifestJson(), "bundle-foreign");
		const error = await refusalOf(
			verifyResolverComponentBundle(
				await signedBundle(built, issuer()),
				verifierFor(issuer()),
			),
		);
		expect(error.componentCode).toBe("component.bundle-signature-failed");
	});

	it("refuses tampered bytes", async () => {
		const signer = issuer();
		const built = build(manifestJson(), "bundle-bytes");
		const bundle = await signedBundle(built, signer);
		const wasm = Uint8Array.from(bundle.wasm);
		wasm[wasm.length - 1] = (wasm.at(-1) ?? 0) ^ 1;
		const error = await refusalOf(
			verifyResolverComponentBundle({ ...bundle, wasm }, verifierFor(signer)),
		);
		expect(error.componentCode).toBe("component.bundle-digest-mismatch");
	});

	it("refuses a widened allowlist that was not re-signed", async () => {
		const signer = issuer();
		const built = build(manifestJson(), "bundle-widen");
		const bundle = await signedBundle(built, signer);
		const widened = build(
			manifestJson({
				egress: [
					{ host: "api.acme.test" },
					{ host: "upload.acme.test" },
					{ host: "evil.example" },
				],
			}),
			"bundle-widen",
		);
		const swapped = await refusalOf(
			verifyResolverComponentBundle(
				{ ...bundle, manifest: widened.manifestJson },
				verifierFor(signer),
			),
		);
		expect(swapped.componentCode).toBe("component.bundle-digest-mismatch");
		const rebound = await refusalOf(
			verifyResolverComponentBundle(
				{
					...bundle,
					manifest: widened.manifestJson,
					registry: {
						...bundle.registry,
						manifest: resolverRegistryManifest(widened.manifest),
					},
				},
				verifierFor(signer),
			),
		);
		expect(rebound.componentCode).toBe("component.bundle-signature-failed");
	});

	it("refuses bytes that are not wasm", async () => {
		const signer = issuer();
		const built = build(manifestJson(), "bundle-magic");
		const bundle = await signedBundle(built, signer);
		const error = await refusalOf(
			verifyResolverComponentBundle(
				{ ...bundle, wasm: new TextEncoder().encode("#!/bin/sh") },
				verifierFor(signer),
			),
		);
		expect(error.componentCode).toBe("component.bundle-digest-mismatch");
	});

	it("refuses to instantiate bytes no engine can run, and a mode the manifest does not allow", async () => {
		const signer = issuer();
		const built = build(manifestJson(), "bundle-engine");
		const verified = await verifyResolverComponentBundle(
			await signedBundle(built, signer),
			verifierFor(signer),
		);
		const options = {
			componentHost: createRuntimeLocalComponentHost({
				appendEvent: () => undefined,
			}),
			engine: createGuestModuleEngine(new Map()),
			mode: "conductor" as const,
			resolveHost: publicDns,
			credentials: new Credentials(),
		};
		expect(
			(await refusalOf(loadResolverComponent(verified, options))).componentCode,
		).toBe("component.engine-unavailable");
		const guest = defineResolverGuest(() => ({
			describe: async () => ({ componentId: "x", version: "0", classes: [] }),
			reconcile: async () => ok(outcome("noop", "x", {})),
			read: async () => ok(null),
			delete: async () => ok(null),
			instances: async () => ok([]),
		}));
		const agentOnly = await refusalOf(
			loadResolverComponent(verified, {
				...options,
				engine: createGuestModuleEngine(
					new Map([[verified.wasmDigest, guest]]),
				),
				mode: "agent",
			}),
		);
		expect(agentOnly.componentCode).toBe("component.manifest-invalid");
	});

	it("component bytes are deterministic for the same source", () => {
		const a = componentizeResolver({
			componentId: "c",
			version: "1.0.0",
			source: "s",
		});
		const b = componentizeResolver({
			componentId: "c",
			version: "1.0.0",
			source: "s",
		});
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
		expect(WebAssembly.validate(a)).toBe(true);
	});

	it("attestation helper signs the registry digest", async () => {
		const token = await attest(issuer(), `sha256:${"0".repeat(64)}`);
		expect(token.split(".")).toHaveLength(3);
	});
});

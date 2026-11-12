// Signed component bundles, verified through @hobo/registry. A bundle is the
// component manifest, the component bytes, and a registry bundle manifest
// whose `hobo:resolver/resolver@0.1.0` capability binds both digests. The
// registry attestation (a JWT from the identity issuer) signs the registry
// manifest digest, so one signature covers the bytes, the allowlist, the
// credential binding and the limits. Verification fails closed: no verifier
// is "unverified", never a pass.
import { createHash } from "node:crypto";
import {
	type BundleManifest,
	bundleManifestDigest,
	ingestBundleManifest,
	type SignatureVerifier,
	type VerifyBundleInput,
	verifyBundleProvenance,
} from "@hobo/registry";
import { ResolverComponentError } from "./errors.js";
import type { JsonObject, JsonValue } from "./json.js";
import {
	type ComponentManifest,
	componentManifestDigest,
	parseComponentManifest,
} from "./manifest.js";

// public-contract: capability port a resolver-component registry bundle declares.
export const RESOLVER_BUNDLE_PORT = "hobo:resolver/resolver@0.1.0" as const;
// public-contract: feature prefixes binding the component manifest and bytes.
export const MANIFEST_FEATURE_PREFIX = "component-manifest:" as const;
export const WASM_FEATURE_PREFIX = "wasm:" as const;

/** What a publisher ships; untrusted until verified. */
export interface ResolverComponentBundle {
	readonly manifest: JsonValue;
	readonly wasm: Uint8Array;
	readonly registry: {
		readonly manifest: JsonValue;
		/** Compact JWT whose codeVersion.digest is the registry manifest digest. */
		readonly attestation: string;
		/** Optional in-toto/SLSA statement binding the registry manifest. */
		readonly statement?: JsonValue;
	};
}

const VERIFIED: unique symbol = Symbol("hobo.resolver-components.verified");

/** A bundle whose signature, digests and manifest all verified. */
export interface VerifiedResolverComponent {
	readonly [VERIFIED]: true;
	readonly manifest: ComponentManifest;
	readonly manifestDigest: string;
	readonly wasmDigest: string;
	readonly wasm: Uint8Array;
	readonly registryDigest: string;
	readonly signedBy: string;
}

/** sha256:<hex> of component bytes. */
export function wasmDigestOf(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The registry bundle manifest document a publisher signs for `manifest`.
 * Used by the build recipe; verification recomputes it, never trusts it.
 */
export function resolverRegistryManifest(
	manifest: ComponentManifest,
	description = `hobo:resolver component ${manifest.id}`,
): JsonObject {
	return {
		schema: "hobo.registry.bundle-manifest/v1",
		name: manifest.id,
		version: manifest.version,
		provider: manifest.providerId,
		capabilities: [
			{
				port: RESOLVER_BUNDLE_PORT,
				features: [
					`${MANIFEST_FEATURE_PREFIX}${componentManifestDigest(manifest)}`,
					`${WASM_FEATURE_PREFIX}${manifest.wasmDigest}`,
				],
			},
		],
		description,
	};
}

/** Verify a bundle end to end. Throws a typed refusal on any failure. */
export async function verifyResolverComponentBundle(
	bundle: ResolverComponentBundle,
	verifier: SignatureVerifier | undefined,
): Promise<VerifiedResolverComponent> {
	const manifest = parseComponentManifest(bundle.manifest);
	const id = manifest.id;
	const wasm = Uint8Array.from(bundle.wasm);
	if (!hasWasmMagic(wasm))
		throw new ResolverComponentError(
			"component.bundle-digest-mismatch",
			"component bytes do not start with the wasm magic",
			id,
		);
	const wasmDigest = wasmDigestOf(wasm);
	if (wasmDigest !== manifest.wasmDigest)
		throw new ResolverComponentError(
			"component.bundle-digest-mismatch",
			`component bytes hash to ${wasmDigest}, the manifest declares ${manifest.wasmDigest}`,
			id,
		);
	const registry = ingestBundleManifest(bundle.registry.manifest);
	if (!registry.ok)
		throw new ResolverComponentError(
			"component.manifest-invalid",
			`registry manifest: ${registry.errors.map((error) => error.message).join("; ")}`,
			id,
		);
	assertBinding(registry.manifest, manifest);
	const input: VerifyBundleInput = {
		manifest: registry.manifest,
		attestation: bundle.registry.attestation,
	};
	if (bundle.registry.statement !== undefined) input.statement = bundle.registry.statement;
	if (verifier !== undefined) input.verifier = verifier;
	const verdict = await verifyBundleProvenance(input);
	if (verdict.status === "unverified")
		throw new ResolverComponentError("component.bundle-unverified", verdict.reason, id);
	if (verdict.status === "failed")
		throw new ResolverComponentError(
			"component.bundle-signature-failed",
			verdict.reasons.join("; "),
			id,
		);
	return Object.freeze({
		[VERIFIED]: true as const,
		manifest,
		manifestDigest: componentManifestDigest(manifest),
		wasmDigest,
		wasm,
		registryDigest: bundleManifestDigest(registry.manifest),
		signedBy: verdict.signedBy,
	});
}

function assertBinding(registry: BundleManifest, manifest: ComponentManifest): void {
	const id = manifest.id;
	const mismatch = (detail: string): ResolverComponentError =>
		new ResolverComponentError("component.bundle-digest-mismatch", detail, id);
	if (registry.name !== manifest.id || registry.version !== manifest.version)
		throw mismatch(
			`registry manifest names ${registry.name}@${registry.version}, the component is ${manifest.id}@${manifest.version}`,
		);
	if (registry.provider !== manifest.providerId)
		throw mismatch(`registry provider ${registry.provider} is not ${manifest.providerId}`);
	const capability = registry.capabilities.find((entry) => entry.port === RESOLVER_BUNDLE_PORT);
	if (capability === undefined) throw mismatch(`registry manifest declares no ${RESOLVER_BUNDLE_PORT} capability`);
	const expected = [
		`${MANIFEST_FEATURE_PREFIX}${componentManifestDigest(manifest)}`,
		`${WASM_FEATURE_PREFIX}${manifest.wasmDigest}`,
	];
	for (const feature of expected) {
		if (!capability.features.includes(feature))
			throw mismatch(`registry manifest does not bind ${feature}`);
	}
	const bound = capability.features.filter(
		(feature) =>
			feature.startsWith(MANIFEST_FEATURE_PREFIX) || feature.startsWith(WASM_FEATURE_PREFIX),
	);
	if (bound.length !== expected.length)
		throw mismatch("registry manifest binds more than one manifest or wasm digest");
}

function hasWasmMagic(bytes: Uint8Array): boolean {
	return bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

/**
 * Verification before execution — enforced by types, not by discipline.
 *
 * {@link verifyPackManifest} is the only producer of {@link VerifiedPackManifest},
 * and every surface that can cause something to run (the conformance harness,
 * the operation planner, the semantics projection that makes a pack selectable)
 * accepts nothing else. So "we forgot to check the signature before pulling" is
 * a compile error rather than an incident.
 *
 * Three rejections, all fail-closed:
 * - a moving tag or a malformed digest → `PACK_INTEGRITY_UNVERIFIED` (already
 *   raised during manifest parsing, re-asserted here for a manifest that was
 *   constructed rather than parsed);
 * - a missing, invalid, untrusted, or unknown-verdict signature →
 *   `PACK_INTEGRITY_UNVERIFIED`;
 * - a requested architecture the manifest does not pin →
 *   `ARCHITECTURE_UNSUPPORTED`.
 *
 * A signed payload whose digest does not match the manifest it arrived with is
 * `PROVIDER_CONTRACT_CHANGED`: the document changed after signing, which is a
 * different failure from a bad key and deserves a different code.
 */
import { architecturesMatch, type PackArchitecture } from "./architecture.js";
import { PackError } from "./errors.js";
import {
	type ParsedPackManifest,
	type PinnedPackImage,
	parsePackManifest,
} from "./manifest.js";
import { type PackSignatureVerifier, sha256Of } from "./signature.js";

declare const verifiedBrand: unique symbol;

/**
 * A manifest whose signature verified against a trusted key and whose image for
 * the requested architecture is digest-pinned.
 */
export type VerifiedPackManifest = ParsedPackManifest & {
	readonly [verifiedBrand]: "VerifiedPackManifest";
	/** The one image that may be pulled for this execution. */
	readonly selectedImage: PinnedPackImage;
	readonly selectedArchitecture: PackArchitecture;
	/** Digest of the canonical payload that was actually verified. */
	readonly verifiedPayloadDigest: string;
	readonly verifiedKeyId: string;
};

export type PackTrustAnchors = {
	/** Key ids the operator accepts. Empty means nothing is trusted. */
	readonly trustedKeyIds: readonly string[];
	/**
	 * Registries a pack image may be pulled from. Empty means nothing is
	 * allowed; a digest proves content but not who is serving it.
	 */
	readonly allowedRegistries: readonly string[];
	/**
	 * Reject a manifest whose conformance outcome is not `pass`. Defaults to
	 * true, because `unknown` conformance is not evidence.
	 */
	readonly requireConformancePass?: boolean;
};

export type VerifyPackManifestInput = {
	readonly manifest: ParsedPackManifest;
	readonly verifier: PackSignatureVerifier;
	readonly anchors: PackTrustAnchors;
	readonly requestedArchitecture: PackArchitecture;
};

function integrityFailure(
	detail: string,
	extra?: Readonly<Record<string, string | number | boolean>>,
): never {
	throw new PackError(
		"PACK_INTEGRITY_UNVERIFIED",
		detail,
		extra !== undefined ? { detail: extra } : {},
	);
}

/**
 * Verify a parsed manifest and narrow it for execution.
 *
 * Pure apart from the injected verifier: no clock, no network, no filesystem.
 * Signature freshness is deliberately not evaluated here — evidence expiry is a
 * selection-time concern that `selectCapabilityImplementation` already gates on
 * with a caller-supplied `nowMs`.
 */
export function verifyPackManifest(
	input: VerifyPackManifestInput,
): VerifiedPackManifest {
	const { manifest, verifier, anchors, requestedArchitecture } = input;

	if (anchors.trustedKeyIds.length === 0) {
		integrityFailure(
			"no trusted signing keys are configured, so no pack manifest can be verified",
		);
	}
	if (!anchors.trustedKeyIds.includes(manifest.signature.keyId)) {
		integrityFailure(
			"pack manifest is signed by a key that is not in the trust anchors",
			{
				keyId: manifest.signature.keyId,
			},
		);
	}

	const payload = manifest.signingPayload;
	const actualDigest = sha256Of(payload);
	if (actualDigest !== manifest.signature.payloadDigest) {
		throw new PackError(
			"PROVIDER_CONTRACT_CHANGED",
			"pack manifest content does not match the payload digest its signature covers; the document changed after it was signed",
			{
				detail: {
					expected: manifest.signature.payloadDigest,
					actual: actualDigest,
				},
			},
		);
	}

	const verdict = verifier.verify({ payload, signature: manifest.signature });
	if (verdict !== "valid") {
		integrityFailure(
			`pack manifest signature verdict is ${verdict}; an unverifiable manifest is treated exactly like a forged one`,
			{ verdict, keyId: manifest.signature.keyId },
		);
	}

	const selectedImage = manifest.images.find((image) =>
		architecturesMatch(image.architecture, requestedArchitecture),
	);
	if (selectedImage === undefined) {
		throw new PackError(
			"ARCHITECTURE_UNSUPPORTED",
			`pack ${manifest.packId} pins no image for ${requestedArchitecture}`,
			{
				detail: {
					requested: requestedArchitecture,
					pinned: manifest.images.map((image) => image.architecture).join(","),
				},
			},
		);
	}

	if (anchors.allowedRegistries.length === 0) {
		integrityFailure(
			"no registries are allowed, so no pack image may be pulled",
		);
	}
	if (!anchors.allowedRegistries.includes(selectedImage.reference.registry)) {
		integrityFailure(
			`pack image registry ${selectedImage.reference.registry} is not in the allowed registry list`,
			{ registry: selectedImage.reference.registry },
		);
	}

	if (
		(anchors.requireConformancePass ?? true) &&
		manifest.conformance.outcome !== "pass"
	) {
		throw new PackError(
			"PACK_CONFORMANCE_FAILED",
			`pack ${manifest.packId} conformance outcome is ${manifest.conformance.outcome}`,
			{ detail: { outcome: manifest.conformance.outcome } },
		);
	}

	// SAFETY: `return {` is required at this I/O or test boundary.
	return {
		...manifest,
		selectedImage,
		selectedArchitecture: selectedImage.architecture,
		verifiedPayloadDigest: actualDigest,
		verifiedKeyId: manifest.signature.keyId,
	} as VerifiedPackManifest;
}

/** Convenience: parse then verify in one step. */
export function parseAndVerifyPackManifest(
	input: Omit<VerifyPackManifestInput, "manifest"> & {
		readonly manifest: Parameters<typeof parsePackManifest>[0];
	},
): VerifiedPackManifest {
	return verifyPackManifest({
		...input,
		manifest: parsePackManifest(input.manifest),
	});
}

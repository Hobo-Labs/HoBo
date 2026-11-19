import { architecturesMatch, type PackArchitecture } from "./architecture.js";
import { PackError } from "./errors.js";
import {
	type ParsedPackManifest,
	type PinnedPackImage,
	parsePackManifest,
} from "./manifest.js";
import { type PackSignatureVerifier, sha256Of } from "./signature.js";

declare const verifiedBrand: unique symbol;

export type VerifiedPackManifest = ParsedPackManifest & {
	readonly [verifiedBrand]: "VerifiedPackManifest";
	readonly selectedImage: PinnedPackImage;
	readonly selectedArchitecture: PackArchitecture;
	readonly verifiedPayloadDigest: string;
	readonly verifiedKeyId: string;
};

export type PackTrustAnchors = {
	readonly trustedKeyIds: readonly string[];
	readonly allowedRegistries: readonly string[];
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

	return {
		...manifest,
		selectedImage,
		selectedArchitecture: selectedImage.architecture,
		verifiedPayloadDigest: actualDigest,
		verifiedKeyId: manifest.signature.keyId,
	} as VerifiedPackManifest;
}

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

// `createArtifactVerifier` (WP3, D3): every artifact in a Freight manifest is
// checked at its coordinate before the ledger records it.
//
// - `store` (or no ecosystem): the bytes must be in the HoBo artifact store
//   and re-hash to the digest (the store verifies on read).
// - Registry ecosystems: the registry's own published digest for exactly the
//   pinned version must equal the manifest digest. When the registry publishes
//   only a different algorithm (npm sha512 integrity, NuGet SHA512, Maven
//   .sha1), the verifier hashes the store's verified copy with that algorithm
//   and compares; without a stored copy it refuses (`…-incomparable`).
// - `git` and `http`: verified only through a stored copy; otherwise refused.
//
// Unknown ecosystems are refused, never "skipped". The verifier is fail-closed:
// the result is ok only when every artifact verified.
import { clone } from "@bufbuild/protobuf";
import type { HttpTransport } from "@hobo/core";
import {
	type ArtifactRef,
	type FreightManifestRecord,
	FreightManifestRecordSchema,
	type ReasonRecord,
} from "../_generated/cd_pb.js";
import type {
	ArtifactStore,
	ArtifactVerifier,
	CdBase,
	CdContext,
	Digest,
	Outcome,
	TelemetrySink,
} from "../ports.js";
import { hashHex, parseDigest } from "./digest.js";
import {
	ARTIFACT_REASON,
	ArtifactStoreError,
	reason,
	refusal,
} from "./reasons.js";
import {
	isRegistryEcosystem,
	lookupRegistryDigest,
	type RegistryDigest,
} from "./registries.js";
import { ARTIFACT_STORE_COORDINATE_PREFIX } from "./store.js";
import { ARTIFACT_METRICS, emit } from "./telemetry.js";

export type ArtifactVerifierDeps = CdBase & {
	readonly artifacts: ArtifactStore;
	readonly http: HttpTransport;
	readonly telemetry?: TelemetrySink;
};

type Check = ReasonRecord | undefined;

function hasCredentials(coordinate: string): boolean {
	const scheme = coordinate.match(/^[a-z][a-z0-9+.-]*:\/\/([^/@]*)@/i);
	return scheme !== null || /\s/.test(coordinate);
}

/** Stored bytes, re-verified; a corrupt copy is a reason, an absent one is undefined. */
async function storedCopy(
	artifacts: ArtifactStore,
	digest: Digest,
	subject: string,
): Promise<Readonly<{ bytes?: Uint8Array; reason?: ReasonRecord }>> {
	try {
		const bytes = await artifacts.get(digest);
		return bytes === undefined ? {} : { bytes };
	} catch (error) {
		if (error instanceof ArtifactStoreError)
			return {
				reason: reason(error.code, error.message, error.remediation, subject),
			};
		return {
			reason: reason(
				ARTIFACT_REASON.backendUnavailable,
				"the artifact store could not be read",
				"Retry when the artifact store is healthy.",
				subject,
			),
		};
	}
}

function sizeCheck(artifact: ArtifactRef, bytes: Uint8Array): Check {
	if (
		artifact.sizeBytes === 0n ||
		artifact.sizeBytes === BigInt(bytes.byteLength)
	)
		return undefined;
	return reason(
		ARTIFACT_REASON.sizeMismatch,
		`manifest says ${artifact.sizeBytes} bytes; the stored artifact has ${bytes.byteLength}`,
		"Regenerate the manifest from the build output; sizes and digests must describe the same bytes.",
		artifact.name,
	);
}

async function verifyStored(
	artifacts: ArtifactStore,
	artifact: ArtifactRef,
	digest: Digest,
): Promise<Check> {
	if (artifact.coordinate.startsWith(ARTIFACT_STORE_COORDINATE_PREFIX)) {
		const named = artifact.coordinate.match(/sha256:[0-9a-f]{64}/)?.[0];
		if (named !== undefined && named !== digest)
			return reason(
				ARTIFACT_REASON.digestMismatch,
				`store coordinate names ${named} but the manifest digest is ${digest}`,
				"Use the ArtifactRef the store returned from put() unchanged.",
				artifact.name,
			);
	}
	const copy = await storedCopy(artifacts, digest, artifact.name);
	if (copy.reason !== undefined) return copy.reason;
	if (copy.bytes === undefined)
		return reason(
			ARTIFACT_REASON.missing,
			`the artifact store holds no ${digest}`,
			"Put the build output in the artifact store before recording Freight that names it.",
			artifact.name,
		);
	return sizeCheck(artifact, copy.bytes);
}

async function compare(
	artifacts: ArtifactStore,
	artifact: ArtifactRef,
	digest: Digest,
	published: readonly RegistryDigest[],
): Promise<Check> {
	const direct = published.filter((entry) => entry.algorithm === "sha256");
	for (const entry of direct)
		if (`sha256:${entry.hex}` !== digest)
			return reason(
				ARTIFACT_REASON.digestMismatch,
				`${entry.source} is sha256:${entry.hex}, not the manifest digest ${digest}`,
				"Do not promote: the bytes at the coordinate are not the bytes the build attested. Rebuild the manifest from the registry's artifact or investigate the registry.",
				artifact.name,
			);
	const indirect = published.filter((entry) => entry.algorithm !== "sha256");
	if (indirect.length === 0) return undefined;
	if (direct.length > 0) {
		// A sha256 already matched; a published second algorithm must agree too
		// when the bytes are at hand, but its absence is not a failure.
		const copy = await storedCopy(artifacts, digest, artifact.name);
		if (copy.reason !== undefined) return copy.reason;
		if (copy.bytes === undefined) return undefined;
		return indirectMismatch(artifact, copy.bytes, indirect);
	}
	const copy = await storedCopy(artifacts, digest, artifact.name);
	if (copy.reason !== undefined) return copy.reason;
	if (copy.bytes === undefined)
		return reason(
			ARTIFACT_REASON.digestIncomparable,
			`${indirect.map((entry) => entry.source).join(", ")} publishes only ${indirect.map((entry) => entry.algorithm).join("/")}, which cannot be compared with ${digest} without the bytes`,
			"Put the exact artifact bytes in the HoBo artifact store (its sha256 must be the manifest digest) so the registry's digest can be checked against them.",
			artifact.name,
		);
	return (
		sizeCheck(artifact, copy.bytes) ??
		indirectMismatch(artifact, copy.bytes, indirect)
	);
}

function indirectMismatch(
	artifact: ArtifactRef,
	bytes: Uint8Array,
	indirect: readonly RegistryDigest[],
): Check {
	for (const entry of indirect) {
		const algorithm = entry.algorithm === "sha1" ? "sha1" : "sha512";
		if (hashHex(algorithm, bytes) !== entry.hex)
			return reason(
				ARTIFACT_REASON.digestMismatch,
				`${entry.source} (${entry.algorithm}) does not match the stored bytes of ${artifact.digest}`,
				"Do not promote: the registry serves different bytes than the build produced.",
				artifact.name,
			);
	}
	return undefined;
}

async function verifyOne(
	d: ArtifactVerifierDeps,
	artifact: ArtifactRef,
): Promise<Check> {
	const digest = parseDigest(artifact.digest);
	if (digest === undefined)
		return reason(
			ARTIFACT_REASON.digestInvalid,
			"artifact digest must be sha256:<64 lowercase hex>",
			"Pin every artifact by its sha256 digest; tags and versions alone are mutable.",
			artifact.name,
		);
	if (artifact.coordinate.trim() === "" || hasCredentials(artifact.coordinate))
		return reason(
			ARTIFACT_REASON.coordinateInvalid,
			"artifact coordinate is empty, contains whitespace, or embeds credentials",
			"Use a plain coordinate; registry credentials belong to the reconciler's credential resolver, never to a record.",
			artifact.name,
		);
	const ecosystem = artifact.ecosystem === "" ? "store" : artifact.ecosystem;
	if (ecosystem === "store") return verifyStored(d.artifacts, artifact, digest);
	if (ecosystem === "git" || ecosystem === "http") {
		const copy = await storedCopy(d.artifacts, digest, artifact.name);
		if (copy.reason !== undefined) return copy.reason;
		if (copy.bytes === undefined)
			return reason(
				ARTIFACT_REASON.unverifiable,
				`${ecosystem} coordinates publish no registry digest, and the artifact store holds no ${digest}`,
				"Put the fetched bytes in the HoBo artifact store; the store's verified copy is what backs the digest.",
				artifact.name,
			);
		return sizeCheck(artifact, copy.bytes);
	}
	if (!isRegistryEcosystem(ecosystem))
		return reason(
			ARTIFACT_REASON.ecosystemUnsupported,
			`ecosystem ${ecosystem} has no registered verifier`,
			"Use one of oci, npm, nuget, pypi, maven, cargo, rubygems, git, http or store.",
			artifact.name,
		);
	const looked = await lookupRegistryDigest(d.http, ecosystem, artifact);
	if (!looked.ok) return looked.reason;
	return compare(d.artifacts, artifact, digest, looked.digests);
}

/** `"./artifacts"` factory (frozen signature in ports.ts `CdFactories`). */
export function createArtifactVerifier(
	d: ArtifactVerifierDeps,
): ArtifactVerifier {
	return {
		async verify(
			manifest: FreightManifestRecord,
			ctx: CdContext,
		): Promise<Outcome<FreightManifestRecord>> {
			const reasons: ReasonRecord[] = [];
			for (const artifact of manifest.artifacts) {
				if (ctx.signal?.aborted)
					return refusal([
						reason(
							ARTIFACT_REASON.registryUnavailable,
							"verification was cancelled before every artifact was checked",
							"Retry the operation.",
							artifact.name,
						),
					]);
				const failed = await verifyOne(d, artifact);
				emit(d.telemetry, ARTIFACT_METRICS.verified, ctx.now(), {
					ecosystem: artifact.ecosystem === "" ? "store" : artifact.ecosystem,
					outcome: failed === undefined ? "verified" : failed.code,
				});
				if (failed !== undefined) reasons.push(failed);
			}
			if (reasons.length > 0) return refusal(reasons);
			return { ok: true, value: clone(FreightManifestRecordSchema, manifest) };
		},
	};
}

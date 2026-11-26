// `createArtifactStore` (WP3, C14): one content-addressed store over three
// backends. The wrapper owns every guarantee the port promises:
//
// - the digest is computed here, never taken from the caller;
// - every read is re-hashed, and a mismatch is a typed `artifact-corrupt`
//   error (never "absent", never the bad bytes);
// - an existing-but-corrupt blob is repaired on the next put of the true bytes;
// - `artifact.Stored`/`artifact.Deleted` are journalled once per transition;
// - metrics go to the optional `TelemetrySink`; nothing secret is recorded.
import { create } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	type ArtifactRef,
	ArtifactRefSchema,
} from "../_generated/cd_pb.js";
import type {
	ArtifactStore,
	ArtifactStoreConfig,
	CdBase,
	CdContext,
	Digest,
	TelemetrySink,
} from "../ports.js";
import type { BlobBackend } from "./backend.js";
import { parseDigest, sha256Digest } from "./digest.js";
import { createFilesystemBackend } from "./filesystem.js";
import { createArtifactJournal } from "./journal.js";
import { createMemoryBackend } from "./memory.js";
import { ARTIFACT_REASON, ArtifactStoreError, corrupt } from "./reasons.js";
import { createS3Backend } from "./s3.js";
import { emit } from "./telemetry.js";

// public-contract: coordinate scheme of a blob held by the artifact store.
export const ARTIFACT_STORE_COORDINATE_PREFIX = "store://";

export type ArtifactStoreDeps = CdBase & { readonly telemetry?: TelemetrySink };

const TEXT_LIMIT = 1024;

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function checkText(field: string, value: string): void {
	if (
		value.trim() === "" ||
		[...value].length > TEXT_LIMIT ||
		hasControlCharacter(value)
	)
		throw new ArtifactStoreError(
			ARTIFACT_REASON.configInvalid,
			`artifact ${field} must be 1-${TEXT_LIMIT} printable characters`,
			`Pass a non-empty ${field} without control characters when putting the artifact.`,
		);
}

export function storeCoordinate(backend: string, digest: Digest): string {
	return `${ARTIFACT_STORE_COORDINATE_PREFIX}${backend}/${digest}`;
}

function checkDigest(value: string): Digest {
	const digest = parseDigest(value);
	if (digest === undefined)
		throw new ArtifactStoreError(
			ARTIFACT_REASON.digestInvalid,
			"artifact digest must be sha256:<64 lowercase hex>",
			"Address blobs by the digest the store returned from put().",
		);
	return digest;
}

/** Wrap a backend with hashing, verify-on-read, journal and telemetry. */
export function createStoreOver(
	backend: BlobBackend,
	d: ArtifactStoreDeps,
): ArtifactStore {
	const journal = createArtifactJournal(d, backend.name);
	const attributes = { backend: backend.name };

	async function verified(digest: Digest): Promise<Uint8Array | undefined> {
		const bytes = await backend.read(digest);
		if (bytes === undefined) return undefined;
		if (sha256Digest(bytes) !== digest) {
			emit(d.telemetry, "hobo.cd.artifact.corrupt", d.now(), attributes);
			throw corrupt(digest, backend.name);
		}
		return bytes;
	}

	return {
		backend: backend.name,
		async put(
			bytes: Uint8Array,
			meta: Readonly<{ name: string; kind: ArtifactKind; mediaType: string }>,
			ctx: CdContext,
		): Promise<ArtifactRef> {
			checkText("name", meta.name);
			checkText("mediaType", meta.mediaType);
			if (
				meta.kind === ArtifactKind.UNSPECIFIED ||
				ArtifactKind[meta.kind] === undefined
			)
				throw new ArtifactStoreError(
					ARTIFACT_REASON.configInvalid,
					"artifact kind must be a declared ArtifactKind",
					"Pass the ArtifactKind that describes the bytes (for example ARTIFACT_KIND_WASM_COMPONENT).",
				);
			if (bytes.byteLength > backend.maxBlobBytes)
				throw new ArtifactStoreError(
					ARTIFACT_REASON.tooLarge,
					`artifact is ${bytes.byteLength} bytes; the ${backend.name} backend stores at most ${backend.maxBlobBytes}`,
					"Store artifacts this large in the filesystem backend, or keep them in their registry and reference them by coordinate.",
				);
			const digest = sha256Digest(bytes);
			const blobMeta = {
				mediaType: meta.mediaType,
				sizeBytes: bytes.byteLength,
			};
			const outcome = await backend.write(digest, bytes, blobMeta, {
				replace: false,
			});
			if (outcome === "exists") {
				let intact = false;
				try {
					intact = (await verified(digest)) !== undefined;
				} catch (error) {
					if (
						!(error instanceof ArtifactStoreError) ||
						error.code !== ARTIFACT_REASON.corrupt
					)
						throw error;
				}
				// Content addressing makes the caller's bytes the truth: repair in place.
				if (!intact)
					await backend.write(digest, bytes, blobMeta, { replace: true });
			}
			const artifact = create(ArtifactRefSchema, {
				name: meta.name,
				kind: meta.kind,
				digest,
				coordinate: storeCoordinate(backend.name, digest),
				sizeBytes: BigInt(bytes.byteLength),
				mediaType: meta.mediaType,
				ecosystem: "store",
			});
			if (await journal.recordStored(artifact, ctx)) {
				emit(d.telemetry, "hobo.cd.artifact.stored", ctx.now(), attributes);
				emit(
					d.telemetry,
					"hobo.cd.artifact.stored.bytes",
					ctx.now(),
					attributes,
					bytes.byteLength,
					"By",
				);
			}
			return artifact;
		},
		async get(digest: Digest) {
			return verified(checkDigest(digest));
		},
		async has(digest: Digest) {
			return backend.exists(checkDigest(digest));
		},
		list(signal: AbortSignal) {
			return backend.keys(signal);
		},
		async delete(digest: Digest, reason: string, ctx: CdContext) {
			const parsed = checkDigest(digest);
			checkText("delete reason", reason);
			await backend.remove(parsed);
			if (await journal.recordDeleted(parsed, reason, ctx))
				emit(d.telemetry, "hobo.cd.artifact.deleted", ctx.now(), attributes);
		},
	};
}

function backendFor(
	config: ArtifactStoreConfig,
	d: ArtifactStoreDeps,
): BlobBackend {
	switch (config.backend) {
		case "memory":
			return createMemoryBackend();
		case "filesystem":
			if (config.root.trim() === "")
				throw new ArtifactStoreError(
					ARTIFACT_REASON.configInvalid,
					"filesystem artifact store needs a root directory",
					"Set the filesystem store root to a directory the CD service owns.",
				);
			return createFilesystemBackend(config.root);
		case "s3-compatible":
			return createS3Backend(config, d.now);
	}
}

/** `"./artifacts"` factory (frozen signature in ports.ts `CdFactories`). */
export function createArtifactStore(
	config: ArtifactStoreConfig,
	d: ArtifactStoreDeps,
): ArtifactStore {
	return createStoreOver(backendFor(config, d), d);
}

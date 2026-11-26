// The byte-level seam under the artifact store. A backend only moves bytes by
// digest; hashing, verification on read, the journal and telemetry live in
// `store.ts`, so every backend gets the same guarantees.
import type { ArtifactStoreConfig, Digest } from "../ports.js";

export type BlobMeta = Readonly<{
	mediaType: string;
	sizeBytes: number;
}>;

/** `created`: this call made the blob visible. `exists`: a blob was already visible at that digest. */
export type WriteOutcome = "created" | "exists";

export interface BlobBackend {
	readonly name: ArtifactStoreConfig["backend"];
	/** Largest blob the backend accepts, in bytes. */
	readonly maxBlobBytes: number;
	/**
	 * Make `bytes` visible at `digest` atomically: a reader sees all of it or
	 * nothing. With `replace: false` an existing blob is left alone and the
	 * result is `exists`; with `replace: true` it is overwritten (repair).
	 */
	write(
		digest: Digest,
		bytes: Uint8Array,
		meta: BlobMeta,
		options: Readonly<{ replace: boolean }>,
	): Promise<WriteOutcome>;
	/** Raw stored bytes, unverified; undefined when absent. */
	read(digest: Digest): Promise<Uint8Array | undefined>;
	exists(digest: Digest): Promise<boolean>;
	keys(signal: AbortSignal): AsyncIterable<Digest>;
	/** Remove the blob; absent is not an error. */
	remove(digest: Digest): Promise<void>;
}

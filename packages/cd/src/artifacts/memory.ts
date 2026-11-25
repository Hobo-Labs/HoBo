// In-process backend for tests, `hobo up` dry runs and single-process demos.
// Bytes are copied in and out, so a caller mutating its buffer can never
// change a stored blob behind the digest.
import type { Digest } from "../ports.js";
import type { BlobBackend, BlobMeta, WriteOutcome } from "./backend.js";

export type MemoryBackend = BlobBackend & {
	/** Direct access to the stored bytes, for fault-injection tests. */
	readonly blobs: Map<Digest, Uint8Array>;
};

export function createMemoryBackend(): MemoryBackend {
	const blobs = new Map<Digest, Uint8Array>();
	return {
		name: "memory",
		maxBlobBytes: Number.MAX_SAFE_INTEGER,
		blobs,
		async write(
			digest: Digest,
			bytes: Uint8Array,
			_meta: BlobMeta,
			options: Readonly<{ replace: boolean }>,
		): Promise<WriteOutcome> {
			if (blobs.has(digest) && !options.replace) return "exists";
			blobs.set(digest, new Uint8Array(bytes));
			return "created";
		},
		async read(digest: Digest) {
			const stored = blobs.get(digest);
			return stored === undefined ? undefined : new Uint8Array(stored);
		},
		async exists(digest: Digest) {
			return blobs.has(digest);
		},
		async *keys(signal: AbortSignal) {
			for (const digest of [...blobs.keys()].sort()) {
				if (signal.aborted) return;
				yield digest;
			}
		},
		async remove(digest: Digest) {
			blobs.delete(digest);
		},
	};
}

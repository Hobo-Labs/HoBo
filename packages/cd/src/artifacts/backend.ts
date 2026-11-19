import type { ArtifactStoreConfig, Digest } from "../ports.js";

export type BlobMeta = Readonly<{
	mediaType: string;
	sizeBytes: number;
}>;

export type WriteOutcome = "created" | "exists";

export interface BlobBackend {
	readonly name: ArtifactStoreConfig["backend"];
	readonly maxBlobBytes: number;
	write(
		digest: Digest,
		bytes: Uint8Array,
		meta: BlobMeta,
		options: Readonly<{ replace: boolean }>,
	): Promise<WriteOutcome>;
	read(digest: Digest): Promise<Uint8Array | undefined>;
	exists(digest: Digest): Promise<boolean>;
	keys(signal: AbortSignal): AsyncIterable<Digest>;
	remove(digest: Digest): Promise<void>;
}

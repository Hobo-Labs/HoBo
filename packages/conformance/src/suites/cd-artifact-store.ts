// ArtifactStore conformance (plan 0024 D3, D18). Content-addressed bytes:
// the digest is the identity, a read never returns bytes that do not hash to
// it, and deletion is explicit.
import { createHash } from "node:crypto";
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	requireCapability,
	runCdAssertions,
	SHA256_DIGEST,
} from "./cd-kit.js";
import { type ArtifactStoreLike, CD_ARTIFACT_KIND } from "./cd-shapes.js";

export const ARTIFACT_STORE_SUITE = "hobo.cd.artifact-store/v1";

// public-contract: assertion names of the ArtifactStore suite.
export const ARTIFACT_STORE_ASSERTIONS = Object.freeze([
	"backendIsDeclared",
	"putIsContentAddressed",
	"putIsIdempotent",
	"getRoundTrips",
	"missingDigestIsAbsent",
	"listEnumeratesStored",
	"deleteRemoves",
	"corruptionIsDetected",
] as const);
export type ArtifactStoreAssertion = (typeof ARTIFACT_STORE_ASSERTIONS)[number];

export interface ArtifactStoreHarness<TCtx> {
	readonly subject: string;
	create(): Promise<{
		store: ArtifactStoreLike<TCtx>;
		/** Flip bytes at rest behind the store's back. */
		corrupt?(digest: `sha256:${string}`): Promise<void>;
	}>;
	ctx(): TCtx;
}

const BACKENDS = new Set(["filesystem", "s3-compatible", "memory"]);

export function sha256Digest(bytes: Uint8Array): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
	const out: string[] = [];
	for await (const digest of iterable) out.push(digest);
	return out;
}

export async function runArtifactStoreConformance<TCtx>(
	harness: ArtifactStoreHarness<TCtx>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<ArtifactStoreAssertion>> {
	const bytes = new TextEncoder().encode("hobo cd conformance artifact\n");
	const other = new TextEncoder().encode("another artifact\n");
	const meta = {
		name: "app",
		kind: CD_ARTIFACT_KIND.WASM_COMPONENT,
		mediaType: "application/wasm",
	} as const;
	const digest = sha256Digest(bytes);
	return runCdAssertions<ArtifactStoreAssertion>(
		ARTIFACT_STORE_SUITE,
		harness.subject,
		{
			backendIsDeclared: async () => {
				const { store } = await harness.create();
				check(
					BACKENDS.has(store.backend),
					`backend ${store.backend} is not a declared backend`,
					"declare filesystem, s3-compatible or memory",
				);
			},
			putIsContentAddressed: async () => {
				const { store } = await harness.create();
				const ref = await store.put(bytes, meta, harness.ctx());
				check(
					SHA256_DIGEST.test(ref.digest),
					`digest ${ref.digest} is not sha256:<hex>`,
					"address content by sha256",
				);
				check(
					ref.digest === digest,
					`digest ${ref.digest} is not the sha256 of the bytes`,
					"the digest is the sha256 of exactly the stored bytes",
				);
				check(
					ref.sizeBytes === undefined || ref.sizeBytes === BigInt(bytes.length),
					`size ${ref.sizeBytes} is not ${bytes.length}`,
					"report the stored size",
				);
			},
			putIsIdempotent: async () => {
				const { store } = await harness.create();
				const a = await store.put(bytes, meta, harness.ctx());
				const b = await store.put(bytes, meta, harness.ctx());
				check(
					a.digest === b.digest,
					"the same bytes got two digests",
					"put is idempotent (I12)",
				);
				const listed = await collect(store.list(new AbortController().signal));
				check(
					listed.filter((entry) => entry === digest).length === 1,
					"the same bytes are listed twice",
					"store each digest once",
				);
			},
			getRoundTrips: async () => {
				const { store } = await harness.create();
				await store.put(bytes, meta, harness.ctx());
				const got = await store.get(digest);
				check(
					got !== undefined && Buffer.from(got).equals(Buffer.from(bytes)),
					"get did not return the stored bytes",
					"return exactly the stored bytes",
				);
				check(
					await store.has(digest),
					"has is false for a stored digest",
					"has reflects stored content",
				);
			},
			missingDigestIsAbsent: async () => {
				const { store } = await harness.create();
				const missing = sha256Digest(other);
				check(
					(await store.get(missing)) === undefined,
					"get of an unknown digest returned bytes",
					"unknown digests read as undefined",
				);
				check(
					!(await store.has(missing)),
					"has is true for an unknown digest",
					"unknown digests are absent",
				);
			},
			listEnumeratesStored: async () => {
				const { store } = await harness.create();
				await store.put(bytes, meta, harness.ctx());
				await store.put(other, meta, harness.ctx());
				const listed = new Set(
					await collect(store.list(new AbortController().signal)),
				);
				check(
					listed.has(digest) && listed.has(sha256Digest(other)),
					"list omits a stored digest",
					"list every stored digest",
				);
			},
			deleteRemoves: async () => {
				const { store } = await harness.create();
				await store.put(bytes, meta, harness.ctx());
				await store.delete(digest, "conformance", harness.ctx());
				check(
					!(await store.has(digest)),
					"has is true after delete",
					"delete removes the content",
				);
				check(
					(await store.get(digest)) === undefined,
					"get returns bytes after delete",
					"delete removes the content",
				);
			},
			corruptionIsDetected: async () => {
				const world = await harness.create();
				const corrupt = requireCapability(world.corrupt, "corrupt");
				await world.store.put(bytes, meta, harness.ctx());
				await corrupt(digest);
				let got: Uint8Array | undefined;
				try {
					got = await world.store.get(digest);
				} catch {
					got = undefined;
				}
				check(
					got === undefined || sha256Digest(got) === digest,
					"get returned bytes that do not hash to their digest",
					"verify the digest on every read; corrupted content blocks promotion (WP3 §10)",
				);
			},
		},
		options,
	);
}

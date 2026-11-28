#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseChallenge } from "../../packages/providers/provider-oci-registry/src/challenge.ts";

const PUBLIC_IMAGE =
	/^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@(sha256:[a-f0-9]{64})$/u;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IMAGE_TYPES = new Set([
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
]);
const INDEX_TYPES = new Set([
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_TYPES = [...INDEX_TYPES, ...IMAGE_TYPES];
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_BLOBS = 2048;
const MAX_MANIFESTS = 256;
const MAX_DEPTH = 8;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const BLOB_CONCURRENCY = 4;
const DEFAULT_TOKEN_RETRY_MS = [0, 2_000, 5_000, 10_000, 15_000] as const;
const tokenSchema = z.object({
	token: z
		.string()
		.min(1)
		.max(32768)
		.regex(/^[a-zA-Z0-9_.+/=-]+$/u),
});
const descriptorSchema = z.object({
	digest: z.string().regex(OCI_DIGEST),
	size: z.number().int().nonnegative().safe(),
	mediaType: z.string().min(1).optional(),
	annotations: z.record(z.string(), z.string()).optional(),
});
const indexSchema = z.object({
	schemaVersion: z.literal(2),
	mediaType: z.string().min(1).optional(),
	manifests: z.array(descriptorSchema).min(1).max(MAX_MANIFESTS),
});
const imageSchema = z.object({
	schemaVersion: z.literal(2),
	mediaType: z.string().min(1).optional(),
	config: descriptorSchema,
	layers: z.array(descriptorSchema).max(MAX_BLOBS),
});
type Descriptor = z.infer<typeof descriptorSchema>;

function tokenRetryDelaysMs(): readonly number[] {
	const raw = process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS?.trim();
	if (!raw) return DEFAULT_TOKEN_RETRY_MS;
	const parsed = raw
		.split(",")
		.map((part) => Number(part.trim()))
		.filter((value) => Number.isFinite(value) && value >= 0);
	return parsed.length > 0 ? parsed : DEFAULT_TOKEN_RETRY_MS;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAnonymousToken(response: Response): Promise<string> {
	if (!response.ok)
		throw new Error(
			`Anonymous GHCR token request failed with HTTP ${response.status}`,
		);
	let tokenDocument: unknown;
	try {
		tokenDocument = JSON.parse(
			(await readBounded(response, 65536)).toString("utf8"),
		);
	} catch {
		throw new Error("Anonymous GHCR token response is invalid");
	}
	const parsedToken = tokenSchema.safeParse(tokenDocument);
	if (!parsedToken.success)
		throw new Error("Anonymous GHCR token response is invalid");
	return parsedToken.data.token;
}

async function requestAnonymousToken(
	repository: string,
	rootDigest: string,
	fetcher: typeof fetch,
): Promise<string> {
	const delays = tokenRetryDelaysMs();
	let lastStatus = 0;
	for (let attempt = 0; attempt < delays.length; attempt++) {
		const delay = delays[attempt] ?? 0;
		if (delay > 0) await sleep(delay);
		const direct = new URL("https://ghcr.io/token");
		direct.searchParams.set("service", "ghcr.io");
		direct.searchParams.set("scope", `repository:${repository}:pull`);
		let tokenResponse = await fetchSafely(
			fetcher,
			direct,
			{
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			},
			"token",
		);
		if (tokenResponse.status === 401) {
			await tokenResponse.body?.cancel().catch(() => undefined);
			const probe = await fetchSafely(
				fetcher,
				`https://ghcr.io/v2/${repository}/manifests/${rootDigest}`,
				{
					headers: { accept: MANIFEST_TYPES.join(", ") },
					redirect: "error",
					signal: AbortSignal.timeout(15_000),
				},
				"manifest",
			);
			if (probe.status === 401) {
				const challenge = parseChallenge(
					probe.headers.get("www-authenticate") ?? undefined,
				);
				await probe.body?.cancel().catch(() => undefined);
				const realmText = challenge.params.realm;
				if (challenge.scheme === "bearer" && realmText) {
					let realm: URL;
					try {
						realm = new URL(realmText);
					} catch {
						throw new Error("Anonymous GHCR bearer realm is invalid");
					}
					if (
						realm.protocol !== "https:" ||
						realm.username !== "" ||
						realm.password !== ""
					)
						throw new Error("Anonymous GHCR bearer realm is not permitted");
					realm.searchParams.set(
						"service",
						challenge.params.service ?? "ghcr.io",
					);
					const scope =
						challenge.params.scope ?? `repository:${repository}:pull`;
					realm.searchParams.set("scope", scope);
					tokenResponse = await fetchSafely(
						fetcher,
						realm,
						{
							redirect: "error",
							signal: AbortSignal.timeout(15_000),
						},
						"token",
					);
				}
			} else {
				await probe.body?.cancel().catch(() => undefined);
			}
		}
		lastStatus = tokenResponse.status;
		if (tokenResponse.ok) return readAnonymousToken(tokenResponse);
		await tokenResponse.body?.cancel().catch(() => undefined);
		if (tokenResponse.status !== 401) break;
	}
	throw new Error(
		`Anonymous GHCR token request failed with HTTP ${lastStatus}`,
	);
}

async function fetchSafely(
	fetcher: typeof fetch,
	url: string | URL,
	options: RequestInit,
	kind: string,
): Promise<Response> {
	try {
		return await fetcher(url, options);
	} catch {
		throw new Error(`Anonymous GHCR ${kind} request failed`);
	}
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
	if (!response.body) throw new Error("Anonymous GHCR response has no body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let item: ReadableStreamReadResult<Uint8Array>;
			try {
				item = await reader.read();
			} catch {
				throw new Error("Anonymous GHCR response read failed");
			}
			if (item.done) break;
			total += item.value.byteLength;
			if (total > limit)
				throw new Error("Anonymous GHCR response exceeds allowed size");
			chunks.push(item.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks, total);
}

async function verifyBlob(
	fetcher: typeof fetch,
	repository: string,
	token: string,
	blob: Descriptor,
	stop: AbortSignal,
): Promise<void> {
	const signal = AbortSignal.any([stop, AbortSignal.timeout(300_000)]);
	let response = await fetchSafely(
		fetcher,
		`https://ghcr.io/v2/${repository}/blobs/${blob.digest}`,
		{
			headers: { authorization: `Bearer ${token}` },
			redirect: "manual",
			signal,
		},
		"blob",
	);
	if ([301, 302, 303, 307, 308].includes(response.status)) {
		const location = response.headers.get("location");
		let target: URL;
		try {
			target = new URL(location ?? "");
		} catch {
			throw new Error("Anonymous GHCR blob redirect is invalid");
		}
		if (
			target.protocol !== "https:" ||
			target.hostname !== "pkg-containers.githubusercontent.com" ||
			target.port !== "" ||
			target.username !== "" ||
			target.password !== "" ||
			target.hash !== ""
		)
			throw new Error("Anonymous GHCR blob redirect is not permitted");
		await response.body?.cancel().catch(() => undefined);
		response = await fetchSafely(
			fetcher,
			target,
			{ redirect: "error", signal },
			"blob delivery",
		);
	}
	if (!response.ok)
		throw new Error(
			`Anonymous GHCR blob request failed with HTTP ${response.status}`,
		);
	if (!response.body) throw new Error("Anonymous GHCR blob has no body");
	const hash = createHash("sha256");
	const reader = response.body.getReader();
	let size = 0;
	try {
		for (;;) {
			let item: ReadableStreamReadResult<Uint8Array>;
			try {
				item = await reader.read();
			} catch {
				throw new Error("Anonymous GHCR response read failed");
			}
			if (item.done) break;
			size += item.value.byteLength;
			if (size > blob.size)
				throw new Error("Anonymous GHCR blob size mismatch");
			hash.update(item.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	if (size !== blob.size || `sha256:${hash.digest("hex")}` !== blob.digest)
		throw new Error("Anonymous GHCR blob digest or size mismatch");
}

export async function verifyPublicGhcrImage(
	ref: string,
	fetcher: typeof fetch = fetch,
): Promise<{ manifestCount: number; blobCount: number; bytes: number }> {
	const match = PUBLIC_IMAGE.exec(ref);
	if (!match) throw new Error("Expected a digest-pinned GHCR image reference");
	const repository = match[1];
	const root = match[2];
	if (!repository || !root)
		throw new Error("Expected a digest-pinned GHCR image reference");
	const token = await requestAnonymousToken(repository, root, fetcher);
	const visited = new Map<
		string,
		{
			size: number;
			runnable: number;
			mediaType: string | undefined;
			responseType: string | undefined;
			kind: "index" | "image";
		}
	>();
	const visiting = new Set<string>();
	const blobs = new Map<string, Descriptor>();
	let totalBytes = 0;
	async function visit(
		digest: string,
		expectedSize: number | undefined,
		depth: number,
		expectedMediaType?: string,
	): Promise<number> {
		if (depth > MAX_DEPTH || visiting.has(digest))
			throw new Error("Anonymous GHCR manifest graph is invalid");
		const prior = visited.get(digest);
		if (prior) {
			if (expectedSize !== undefined && prior.size !== expectedSize)
				throw new Error("Anonymous GHCR manifest size mismatch");
			if (
				expectedMediaType &&
				(!(prior.kind === "index" ? INDEX_TYPES : IMAGE_TYPES).has(
					expectedMediaType,
				) ||
					(prior.mediaType !== undefined &&
						prior.mediaType !== expectedMediaType) ||
					(prior.responseType !== undefined &&
						prior.responseType !== expectedMediaType))
			)
				throw new Error("Anonymous GHCR descriptor media type mismatch");
			return prior.runnable;
		}
		if (visited.size + visiting.size >= MAX_MANIFESTS)
			throw new Error("Anonymous GHCR manifest graph is too large");
		visiting.add(digest);
		const response = await fetchSafely(
			fetcher,
			`https://ghcr.io/v2/${repository}/manifests/${digest}`,
			{
				headers: {
					authorization: `Bearer ${token}`,
					accept: MANIFEST_TYPES.join(", "),
				},
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
			},
			"manifest",
		);
		if (!response.ok)
			throw new Error(
				`Anonymous GHCR manifest request failed with HTTP ${response.status}`,
			);
		const responseType =
			response.headers
				.get("content-type")
				?.split(";")[0]
				?.trim()
				.toLowerCase() || undefined;
		const bytes = await readBounded(response, MAX_MANIFEST_BYTES);
		if (expectedSize !== undefined && bytes.byteLength !== expectedSize)
			throw new Error("Anonymous GHCR manifest size mismatch");
		if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest)
			throw new Error("Anonymous GHCR manifest digest mismatch");
		let doc: unknown;
		try {
			doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			throw new Error("Anonymous GHCR manifest JSON is invalid");
		}
		const index = indexSchema.safeParse(doc);
		const image = imageSchema.safeParse(doc);
		if (index.success === image.success)
			throw new Error("Anonymous GHCR manifest shape is invalid");
		let runnable = 0;
		let kind: "index" | "image";
		let mediaType: string | undefined;
		if (index.success) {
			kind = "index";
			mediaType = index.data.mediaType;
			if (
				expectedMediaType &&
				(!INDEX_TYPES.has(expectedMediaType) ||
					(mediaType !== undefined && mediaType !== expectedMediaType))
			)
				throw new Error("Anonymous GHCR descriptor media type mismatch");
			if (index.data.mediaType && !INDEX_TYPES.has(index.data.mediaType))
				throw new Error("Anonymous GHCR index media type is invalid");
			if (
				responseType &&
				(!INDEX_TYPES.has(responseType) ||
					(mediaType !== undefined && mediaType !== responseType) ||
					(expectedMediaType !== undefined &&
						expectedMediaType !== responseType))
			)
				throw new Error("Anonymous GHCR response media type mismatch");
			for (const child of index.data.manifests) {
				if (
					child.mediaType &&
					!INDEX_TYPES.has(child.mediaType) &&
					!IMAGE_TYPES.has(child.mediaType)
				)
					throw new Error("Anonymous GHCR child media type is invalid");
				const childRunnable = await visit(
					child.digest,
					child.size,
					depth + 1,
					child.mediaType,
				);
				if (
					child.annotations?.["vnd.docker.reference.type"] !==
					"attestation-manifest"
				)
					runnable += childRunnable;
			}
		} else if (image.success) {
			kind = "image";
			mediaType = image.data.mediaType;
			if (
				expectedMediaType &&
				(!IMAGE_TYPES.has(expectedMediaType) ||
					(mediaType !== undefined && mediaType !== expectedMediaType))
			)
				throw new Error("Anonymous GHCR descriptor media type mismatch");
			if (image.data.mediaType && !IMAGE_TYPES.has(image.data.mediaType))
				throw new Error("Anonymous GHCR image media type is invalid");
			if (
				responseType &&
				(!IMAGE_TYPES.has(responseType) ||
					(mediaType !== undefined && mediaType !== responseType) ||
					(expectedMediaType !== undefined &&
						expectedMediaType !== responseType))
			)
				throw new Error("Anonymous GHCR response media type mismatch");
			for (const blob of [image.data.config, ...image.data.layers]) {
				const priorBlob = blobs.get(blob.digest);
				if (priorBlob && priorBlob.size !== blob.size)
					throw new Error("Anonymous GHCR blob descriptor conflict");
				if (!priorBlob) {
					totalBytes += blob.size;
					if (blobs.size >= MAX_BLOBS || totalBytes > MAX_TOTAL_BYTES)
						throw new Error("Anonymous GHCR image is too large to verify");
					blobs.set(blob.digest, blob);
				}
			}
			runnable = 1;
		} else {
			throw new Error("Anonymous GHCR manifest shape is invalid");
		}
		visiting.delete(digest);
		visited.set(digest, {
			size: bytes.byteLength,
			runnable,
			mediaType,
			responseType,
			kind,
		});
		return runnable;
	}
	if ((await visit(root, undefined, 0)) === 0)
		throw new Error("Anonymous GHCR index has no runnable image");
	const remaining = [...blobs.values()];
	const controller = new AbortController();
	let cursor = 0;
	await Promise.all(
		Array.from(
			{ length: Math.min(BLOB_CONCURRENCY, remaining.length) },
			async () => {
				try {
					while (cursor < remaining.length) {
						const blob = remaining[cursor++];
						if (!blob) throw new Error("Anonymous GHCR blob work item missing");
						await verifyBlob(
							fetcher,
							repository,
							token,
							blob,
							controller.signal,
						);
					}
				} catch (error) {
					controller.abort();
					throw error;
				}
			},
		),
	);
	return {
		manifestCount: visited.size,
		blobCount: blobs.size,
		bytes: totalBytes,
	};
}

export { requestAnonymousToken };

async function main(): Promise<void> {
	if (process.argv.length !== 3)
		throw new Error("Usage: verify-ghcr-public <ghcr-image@sha256:digest>");
	const started = Date.now();
	const result = await verifyPublicGhcrImage(process.argv[2] ?? "");
	console.log(
		`Anonymous GHCR image verified: ${result.manifestCount} manifests, ${result.blobCount} blobs, ${result.bytes} bytes in ${Date.now() - started}ms`,
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error: Error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}

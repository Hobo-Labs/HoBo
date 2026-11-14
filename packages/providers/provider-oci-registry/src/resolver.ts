/**
 * The `oci-registry.image/v1` realizer: an image or index at a repository,
 * identified by digest, plus the tags the desired state declares.
 *
 * Works against any distribution-spec registry: GHCR, Docker Hub, ECR,
 * Artifact Registry, Harbor, Zot. Realization goes through the core
 * `ResourceResolver` port and nothing else; HTTP goes through the host's
 * `HttpTransport`, guarded per host by `session.ts`.
 *
 * converge (`reconcile`):
 *
 * 1. HEAD the manifest by digest at the target. Present means content is done.
 * 2. Otherwise copy it. A child manifest of an index is copied first. Each
 *    config and layer blob is skipped when the target already has it, then
 *    mounted across repositories when the source is on the same host, then
 *    uploaded from the host's artifact store or the source registry. Bytes are
 *    hashed before upload and must equal the descriptor digest, and the
 *    registry verifies the digest again on the final PUT. The manifest is PUT
 *    by digest with its exact bytes.
 * 3. PUT each declared tag with the same bytes. A tag the desired state does
 *    not name is never written.
 * 4. Copy referrers (attestations, signatures, SBOMs) of the subject from the
 *    source, through the referrers API or its tag-schema fallback index.
 * 5. Observe: HEAD by digest and by every tag. Convergence is reported only
 *    from that observation (I5).
 *
 * The digest never changes (D22): manifests are copied byte for byte, never
 * re-serialized, converted or platform-filtered.
 *
 * Idempotent by digest. Every write is content-addressed or a tag PUT of the
 * same bytes, so repeating any of them is harmless. When a write's outcome is
 * ambiguous (the transport failed after sending), the realizer observes
 * instead of retrying. If the effect is visible it continues; if not, it
 * refuses, and the next reconcile is safe to run.
 *
 * delete: removes only the tags the desired state declares, and only while
 * they still point at this digest. It deletes the manifest by digest only when
 * the host policy `allowManifestDelete` is set, because that removes the
 * content for every tag and every referrer that shares it.
 */
import {
	createResolverRegistry,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
	TransportGuardError,
	type TransportResponse,
} from "@hobo/core";
import {
	instrumentResolvers,
	type ResolverTelemetryOptions,
} from "./delivery-coverage.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "./json.js";
import {
	type Descriptor,
	manifestMediaType,
	parseManifest,
	parseReferrers,
} from "./manifest.js";
import {
	digestOf,
	isDigest,
	isRegistryHost,
	isRepository,
	isTag,
	MANIFEST_ACCEPT,
	OCI_IMAGE_INDEX,
	OCI_REGISTRY_IMAGE_PRODUCT_ID,
	OCI_REGISTRY_PROVIDER_ID,
	physicalIdOf,
	referrersFallbackTag,
	rejected,
	unparseable,
} from "./reference.js";
import {
	decodeBody,
	encodeBody,
	header,
	type OciRegistryCredential,
	type OciRegistryEndpoint,
	openSession,
	REDIRECT_HEADER,
	type RegistrySession,
	type TransportBodyEncoding,
} from "./session.js";

/** Host-supplied content-addressed store (for example `@hobo/ci` outputs). */
export interface OciArtifactStore {
	/** The exact bytes stored under `digest`, or `undefined` when absent. */
	get(digest: string): Promise<Uint8Array | undefined>;
}

export interface OciRegistryResolverOptions extends ResolverTelemetryOptions {
	/** The registry this realizer writes to. Desired state cannot redirect it. */
	readonly registry: OciRegistryEndpoint;
	/** Registries content may be copied from; the target host is always one. */
	readonly sourceRegistries?: readonly OciRegistryEndpoint[];
	/** Resolves a locator to registry credential material, at call time. */
	readonly resolveCredential: (ref: string) => Promise<OciRegistryCredential>;
	readonly artifactStore?: OciArtifactStore;
	/** Default `utf-8` (the stock fetch transport). See `TransportBodyEncoding`. */
	readonly transportBodyEncoding?: TransportBodyEncoding;
	/** Policy: delete the manifest by digest after its declared tags. Default false. */
	readonly allowManifestDelete?: boolean;
	readonly timeoutMs?: number;
	/** Largest blob moved through the transport. Default 64 MiB. */
	readonly maxBlobBytes?: number;
	/** Upload chunk size; larger blobs use chunked upload (latin1 only). Default 8 MiB. */
	readonly chunkBytes?: number;
}

const DESIRED_KEYS = new Set([
	"registry",
	"repository",
	"digest",
	"tags",
	"sourceRegistry",
	"sourceRepository",
	"copyReferrers",
]);
const MAX_TAGS = 64;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 2;

interface Target {
	readonly request: ResolveRequest;
	readonly repository: string;
	readonly digest: string;
	readonly tags: readonly string[];
	readonly source:
		| undefined
		| {
				readonly endpoint: OciRegistryEndpoint;
				readonly repository: string;
		  };
	readonly copyReferrers: boolean;
	readonly physicalId: string;
}

interface Copy {
	readonly target: RegistrySession;
	readonly repository: string;
	readonly source:
		| undefined
		| {
				readonly session: RegistrySession;
				readonly repository: string;
				readonly sameHost: boolean;
		  };
	readonly stats: {
		manifestsPut: number;
		blobsPresent: number;
		blobsMounted: number;
		blobsUploaded: number;
		blobsSkipped: number;
	};
	readonly visited: Set<string>;
}

type ManifestState =
	| { readonly present: true; readonly digest: string }
	| { readonly present: false };

/** An HTTP status the realizer did not expect, as a typed refusal. */
function unexpected(response: TransportResponse, what: string): never {
	const body = parseJsonObject(response.body);
	const codes = isJsonArray(body.errors)
		? body.errors
				.map((entry) => (isJsonObject(entry) ? entry.code : undefined))
				.filter(
					(code): code is string =>
						isJsonString(code) && /^[A-Z_]{1,64}$/u.test(code),
				)
		: [];
	// Only the spec's error-code enumeration is echoed; never a body or header.
	return rejected(
		`${what} answered HTTP ${response.status}${codes.length ? ` (${codes.join(", ")})` : ""}`,
		response.status === 403
			? "grant the credential behind the locator the needed repository permission"
			: undefined,
	);
}

/** A transport failure after a write was sent: its outcome is unknown. */
function sentButUnknown(error: Error): boolean {
	if (error instanceof ResolverError) return false;
	if (error instanceof TransportGuardError)
		// Request-side refusals happen before anything is sent.
		return ![
			"TRANSPORT_SCHEME_FORBIDDEN",
			"TRANSPORT_HOST_FORBIDDEN",
			"TRANSPORT_PATH_FORBIDDEN",
		].includes(error.code);
	return true;
}

/**
 * Every failure leaves as a typed `ResolverError`. A raw transport failure on a
 * read means nothing was observed, so it is a refusal (I5), never a success.
 */
async function settled<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof ResolverError) throw error;
		const code = error instanceof TransportGuardError ? ` (${error.code})` : "";
		return rejected(
			`registry transport failed${code}; nothing past the last observation is assumed`,
			"re-run; every write is content-addressed and observed before it counts",
		);
	}
}

export function createOciRegistryResolvers(
	options: OciRegistryResolverOptions,
): readonly ResourceResolver[] {
	const registry = endpoint(options.registry, "registry");
	const sources = new Map<string, OciRegistryEndpoint>([
		[registry.host, registry],
	]);
	for (const entry of options.sourceRegistries ?? []) {
		const parsed = endpoint(entry, "sourceRegistries[]");
		if (parsed.host !== registry.host) sources.set(parsed.host, parsed);
	}
	const encoding = options.transportBodyEncoding ?? "utf-8";
	if (encoding !== "utf-8" && encoding !== "latin1")
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"transportBodyEncoding must be 'utf-8' or 'latin1'",
			OCI_REGISTRY_IMAGE_PRODUCT_ID,
		);
	const timeoutMs = bounded(options.timeoutMs, 60_000, "timeoutMs");
	const maxBlobBytes = bounded(
		options.maxBlobBytes,
		64 * 1024 * 1024,
		"maxBlobBytes",
	);
	const chunkBytes = bounded(options.chunkBytes, 8 * 1024 * 1024, "chunkBytes");
	const limits = {
		timeoutMs,
		maxResponseBytes: Math.max(maxBlobBytes, MAX_MANIFEST_BYTES),
	};

	function parseTarget(raw: ResolveRequest): Target {
		const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
		if (request.ref.productId !== OCI_REGISTRY_IMAGE_PRODUCT_ID)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`OCI registry realizer cannot operate on ${request.ref.productId}`,
				request.ref.productId,
			);
		const desired = request.desired;
		for (const key of Object.keys(desired))
			if (!DESIRED_KEYS.has(key))
				rejected(`OCI registry realizer does not implement desired.${key}`);
		if (desired.registry !== registry.host)
			rejected(
				"desired.registry differs from the registry the host bound",
				"bind the Camp to the registry the Set targets; desired state cannot redirect credentials",
			);
		const repository = desired.repository;
		if (!isJsonString(repository) || !isRepository(repository))
			rejected("desired.repository is not a distribution repository name");
		const digest = desired.digest;
		if (!isJsonString(digest) || !isDigest(digest))
			rejected(
				"desired.digest must be a sha256 digest",
				"promote by digest; a tag is a pointer, not an identity",
			);
		const tags = parseTags(desired.tags);
		const copyReferrers = desired.copyReferrers ?? true;
		if (!isJsonBoolean(copyReferrers))
			rejected("desired.copyReferrers must be a boolean");
		let source: Target["source"];
		if (
			desired.sourceRegistry !== undefined ||
			desired.sourceRepository !== undefined
		) {
			const host = desired.sourceRegistry;
			const from = desired.sourceRepository;
			if (!isJsonString(host) || !isJsonString(from) || !isRepository(from))
				rejected(
					"desired.sourceRegistry and desired.sourceRepository go together and must be valid",
				);
			const bound = sources.get(host);
			if (bound === undefined)
				rejected(
					`source registry ${JSON.stringify(host)} is not one the host bound`,
					"add it to sourceRegistries with its realm and blob hosts",
				);
			if (host === registry.host && from === repository)
				rejected("source and target are the same repository");
			source = { endpoint: bound, repository: from };
		}
		const physicalId = physicalIdOf(registry.host, repository, digest);
		if (
			request.ref.physicalId !== undefined &&
			request.ref.physicalId !== physicalId
		)
			rejected(
				"ref.physicalId names other content than desired",
				"a digest never changes in place; promote new content as a new resource",
			);
		return {
			request,
			repository,
			digest,
			tags,
			source,
			copyReferrers,
			physicalId,
		};
	}

	async function targetSession(
		target: Target,
		transport: HttpTransport,
	): Promise<RegistrySession> {
		return openSession({
			endpoint: registry,
			credential: await options.resolveCredential(target.request.credentialRef),
			transport,
			limits,
		});
	}

	async function copyContext(
		target: Target,
		session: RegistrySession,
		transport: HttpTransport,
	): Promise<Copy> {
		let source: Copy["source"];
		if (target.source) {
			const sameHost = target.source.endpoint.host === registry.host;
			const ref = target.source.endpoint.credentialRef;
			source = {
				sameHost,
				repository: target.source.repository,
				session: sameHost
					? session
					: openSession({
							endpoint: target.source.endpoint,
							credential:
								ref === undefined
									? { kind: "anonymous" }
									: await options.resolveCredential(ref),
							transport,
							limits,
						}),
			};
		}
		return {
			target: session,
			repository: target.repository,
			source,
			stats: {
				manifestsPut: 0,
				blobsPresent: 0,
				blobsMounted: 0,
				blobsUploaded: 0,
				blobsSkipped: 0,
			},
			visited: new Set(),
		};
	}

	const push = (repository: string) => [`repository:${repository}:pull,push`];
	const pull = (repository: string) => [`repository:${repository}:pull`];

	/** HEAD a manifest; resolve a missing digest header by hashing a GET. */
	async function headManifest(
		session: RegistrySession,
		repository: string,
		reference: string,
		scopes: readonly string[],
	): Promise<ManifestState> {
		const response = await session.send({
			method: "HEAD",
			path: `/v2/${repository}/manifests/${reference}`,
			scopes,
			headers: { accept: MANIFEST_ACCEPT },
		});
		if (response.status === 404) return { present: false };
		if (response.status !== 200)
			unexpected(response, `HEAD manifest ${reference}`);
		const reported = header(response, "docker-content-digest");
		if (reported !== undefined) {
			if (!isDigest(reported))
				unparseable(`registry reported a malformed digest for ${reference}`);
			if (isDigest(reference) && reported !== reference)
				rejected(`registry served ${reported} for digest ${reference}`);
			return { present: true, digest: reported };
		}
		const fetched = await getManifest(session, repository, reference, scopes);
		return fetched
			? { present: true, digest: fetched.digest }
			: { present: false };
	}

	async function getManifest(
		session: RegistrySession,
		repository: string,
		reference: string,
		scopes: readonly string[],
	): Promise<
		| {
				text: string;
				bytes: Uint8Array;
				digest: string;
				mediaType: string | undefined;
		  }
		| undefined
	> {
		const response = await session.send({
			method: "GET",
			path: `/v2/${repository}/manifests/${reference}`,
			scopes,
			headers: { accept: MANIFEST_ACCEPT },
			maxResponseBytes: MAX_MANIFEST_BYTES,
		});
		if (response.status === 404) return undefined;
		if (response.status !== 200)
			unexpected(response, `GET manifest ${reference}`);
		const bytes = decodeBody(response.body, encoding);
		const digest = digestOf(bytes);
		if (isDigest(reference) && digest !== reference)
			rejected(
				`manifest bytes served for ${reference} hash to ${digest}`,
				"the source or the transport altered the manifest; a mirror must keep digests",
			);
		const mediaType = header(response, "content-type");
		return { text: manifestText(bytes, reference), bytes, digest, mediaType };
	}

	/** A JSON body as text, whatever the transport's body encoding. */
	function textOf(body: string): string {
		return encoding === "utf-8"
			? body
			: manifestText(decodeBody(body, encoding), "the response");
	}

	async function loadManifest(
		copy: Copy,
		digest: string,
	): Promise<{
		text: string;
		bytes: Uint8Array;
		mediaType: string | undefined;
	}> {
		const stored = await options.artifactStore?.get(digest);
		if (stored !== undefined) {
			if (digestOf(stored) !== digest)
				rejected(
					`artifact store returned bytes for ${digest} that hash elsewhere`,
				);
			return {
				text: manifestText(stored, digest),
				bytes: stored,
				mediaType: undefined,
			};
		}
		if (!copy.source)
			rejected(
				`manifest ${digest} is absent at the target and no source names it`,
				"set desired.sourceRegistry/sourceRepository, or provide it through the host artifact store",
			);
		const fetched = await getManifest(
			copy.source.session,
			copy.source.repository,
			digest,
			pull(copy.source.repository),
		);
		if (!fetched)
			rejected(
				`source ${copy.source.session.host}/${copy.source.repository} cannot serve ${digest}`,
				"a mirror never substitutes content; publish the digest to the source first",
			);
		return fetched;
	}

	async function blobPresent(copy: Copy, digest: string): Promise<boolean> {
		const response = await copy.target.send({
			method: "HEAD",
			path: `/v2/${copy.repository}/blobs/${digest}`,
			scopes: push(copy.repository),
		});
		if (response.status === 404) return false;
		if (response.status === 200) return true;
		return unexpected(response, `HEAD blob ${digest}`);
	}

	async function readBlob(copy: Copy, blob: Descriptor): Promise<Uint8Array> {
		const stored = await options.artifactStore?.get(blob.digest);
		let bytes = stored;
		if (bytes === undefined) {
			if (!copy.source)
				rejected(
					`blob ${blob.digest} is absent at the target and no source names it`,
					"set desired.sourceRegistry/sourceRepository or provide the artifact store",
				);
			let response: TransportResponse;
			try {
				response = await copy.source.session.send({
					method: "GET",
					path: `/v2/${copy.source.repository}/blobs/${blob.digest}`,
					scopes: pull(copy.source.repository),
					maxResponseBytes: maxBlobBytes,
				});
				const location = header(response, REDIRECT_HEADER);
				if (location !== undefined)
					response = await copy.source.session.followBlobRedirect(
						location,
						maxBlobBytes,
					);
			} catch (error) {
				if (error instanceof ResolverError) throw error;
				return rejected(
					`reading blob ${blob.digest} from ${copy.source.session.host} failed in transport`,
					encoding === "utf-8"
						? "binary layers do not survive a UTF-8 text transport: mount from the same registry, supply the host artifact store, or run with a latin1 byte transport"
						: "retry; blob reads are idempotent",
				);
			}
			if (response.status !== 200)
				unexpected(response, `GET blob ${blob.digest}`);
			bytes = decodeBody(response.body, encoding);
		}
		if (bytes.byteLength !== blob.size || digestOf(bytes) !== blob.digest)
			rejected(
				`blob bytes for ${blob.digest} do not match the descriptor`,
				encoding === "utf-8"
					? "a UTF-8 text transport cannot carry this blob: mount it, supply the artifact store, or use a latin1 byte transport"
					: "the source or the transport altered the blob; a mirror never changes a digest",
			);
		return bytes;
	}

	function uploadLocation(copy: Copy, response: TransportResponse): string {
		const location = header(response, "location");
		if (location === undefined) unparseable("upload session has no Location");
		const url = new URL(location, `https://${copy.target.host}`);
		if (
			url.hostname !== copy.target.host ||
			!url.pathname.startsWith(`/v2/${copy.repository}/blobs/uploads/`)
		)
			rejected(
				"registry handed an upload session outside its own blob upload path",
				"uploads to a foreign host would carry the registry credential there",
			);
		return `${url.pathname}${url.search}`;
	}

	function withDigest(location: string, digest: string): string {
		return `${location}${location.includes("?") ? "&" : "?"}digest=${encodeURIComponent(digest)}`;
	}

	async function upload(
		copy: Copy,
		blob: Descriptor,
		bytes: Uint8Array,
		session: string | undefined,
	): Promise<void> {
		const scopes = push(copy.repository);
		let location = session;
		if (location === undefined) {
			const started = await copy.target.send({
				method: "POST",
				path: `/v2/${copy.repository}/blobs/uploads/`,
				scopes,
				headers: { "content-length": "0" },
			});
			if (started.status !== 202) unexpected(started, "start blob upload");
			location = uploadLocation(copy, started);
		}
		if (bytes.byteLength <= chunkBytes) {
			const body = encodeBody(bytes, encoding);
			if (body === undefined)
				rejected(
					`blob ${blob.digest} is binary and the host transport carries UTF-8 text`,
					"mount from the same registry, or run with transportBodyEncoding 'latin1' on a byte transport",
				);
			const done = await copy.target.send({
				method: "PUT",
				path: withDigest(location, blob.digest),
				scopes,
				headers: {
					"content-type": "application/octet-stream",
					"content-length": String(bytes.byteLength),
				},
				body,
			});
			if (done.status !== 201) unexpected(done, `upload blob ${blob.digest}`);
			return;
		}
		if (encoding !== "latin1")
			rejected(
				`blob ${blob.digest} needs a chunked upload, which a UTF-8 text transport cannot split safely`,
				"run with transportBodyEncoding 'latin1', or raise chunkBytes",
			);
		for (let start = 0; start < bytes.byteLength; start += chunkBytes) {
			const chunk = bytes.subarray(
				start,
				Math.min(start + chunkBytes, bytes.byteLength),
			);
			const patched = await copy.target.send({
				method: "PATCH",
				path: location,
				scopes,
				headers: {
					"content-type": "application/octet-stream",
					"content-length": String(chunk.byteLength),
					"content-range": `${start}-${start + chunk.byteLength - 1}`,
				},
				body: Buffer.from(chunk).toString("latin1"),
			});
			if (patched.status !== 202)
				unexpected(patched, `upload chunk of ${blob.digest}`);
			location = uploadLocation(copy, patched);
		}
		const closed = await copy.target.send({
			method: "PUT",
			path: withDigest(location, blob.digest),
			scopes,
			headers: { "content-length": "0" },
		});
		if (closed.status !== 201)
			unexpected(closed, `close upload of ${blob.digest}`);
	}

	/**
	 * Ask the registry to mount `blob` from `from` on the same host. A mount is
	 * an optimization, never a requirement: a refusal of the source scope (the
	 * credential may not read `from`) returns undefined and the caller
	 * uploads. A transport failure is not swallowed; the caller resolves it by
	 * observation.
	 */
	async function mountBlob(
		copy: Copy,
		from: string,
		blob: Descriptor,
	): Promise<TransportResponse | undefined> {
		try {
			return await copy.target.send({
				method: "POST",
				path: `/v2/${copy.repository}/blobs/uploads/?mount=${encodeURIComponent(blob.digest)}&from=${encodeURIComponent(from)}`,
				scopes: [...push(copy.repository), ...pull(from)],
				headers: { "content-length": "0" },
			});
		} catch (error) {
			if (
				error instanceof ResolverError &&
				error.code === "RESOLVER_PROVIDER_REJECTED"
			)
				return undefined;
			throw error;
		}
	}

	async function ensureBlob(copy: Copy, blob: Descriptor): Promise<void> {
		if (await blobPresent(copy, blob.digest)) {
			copy.stats.blobsPresent++;
			return;
		}
		let session: string | undefined;
		try {
			if (copy.source?.sameHost) {
				const mounted = await mountBlob(copy, copy.source.repository, blob);
				if (mounted?.status === 201) {
					if (!(await blobPresent(copy, blob.digest)))
						rejected(
							`registry acknowledged a mount of ${blob.digest} that HEAD does not show`,
						);
					copy.stats.blobsMounted++;
					return;
				}
				// 202: the registry declined the mount and opened an upload session.
				// Anything else (the source is unknown or not readable with this
				// credential) declines the mount too: the bytes are uploaded.
				if (mounted?.status === 202) session = uploadLocation(copy, mounted);
			}
			if (blob.size > maxBlobBytes)
				rejected(
					`blob ${blob.digest} is ${blob.size} bytes, over the ${maxBlobBytes}-byte transport bound`,
					"mount it from the same registry, or raise maxBlobBytes on a byte transport",
				);
			await upload(copy, blob, await readBlob(copy, blob), session);
		} catch (error) {
			if (!(error instanceof Error) || !sentButUnknown(error)) throw error;
			// Ambiguous: resolve by observation, never by a blind retry.
		}
		if (!(await blobPresent(copy, blob.digest)))
			rejected(
				`blob ${blob.digest} is not observed at the target after upload`,
				"re-run reconcile; content-addressed uploads are safe to repeat",
			);
		copy.stats.blobsUploaded++;
	}

	/** PUT exact manifest bytes under a digest or a declared tag, then observe. */
	async function putManifest(
		copy: Copy,
		reference: string,
		digest: string,
		bytes: Uint8Array,
		mediaType: string,
	): Promise<TransportResponse | undefined> {
		// The exact manifest bytes, as this transport carries bytes.
		const body = encodeBody(bytes, encoding);
		if (body === undefined)
			return unparseable(`manifest ${digest} is not UTF-8`);
		let response: TransportResponse | undefined;
		try {
			response = await copy.target.send({
				method: "PUT",
				path: `/v2/${copy.repository}/manifests/${reference}`,
				scopes: push(copy.repository),
				headers: { "content-type": mediaType },
				body,
				maxResponseBytes: 64 * 1024,
			});
		} catch (error) {
			if (!(error instanceof Error) || !sentButUnknown(error)) throw error;
		}
		if (response !== undefined) {
			if (response.status !== 201)
				unexpected(response, `PUT manifest ${reference}`);
			const reported = header(response, "docker-content-digest");
			if (reported !== undefined && reported !== digest)
				rejected(
					`registry stored ${reference} as ${reported}, not ${digest}`,
					"the registry rewrote the manifest; a mirror must keep digests",
				);
		}
		const observed = await headManifest(
			copy.target,
			copy.repository,
			reference,
			push(copy.repository),
		);
		if (!observed.present || observed.digest !== digest)
			rejected(
				`${reference} is not observed at ${digest} after the write`,
				"another writer may hold the tag; re-run reconcile to observe and converge",
			);
		return response;
	}

	async function copyManifest(
		copy: Copy,
		digest: string,
		depth: number,
	): Promise<boolean> {
		if (copy.visited.has(digest)) return false;
		copy.visited.add(digest);
		const state = await headManifest(
			copy.target,
			copy.repository,
			digest,
			push(copy.repository),
		);
		if (state.present) return false;
		if (depth > MAX_DEPTH)
			rejected(`manifest nesting past depth ${MAX_DEPTH} is not copied`);
		const loaded = await loadManifest(copy, digest);
		const parsed = parseManifest(loaded.text, loaded.mediaType);
		for (const child of parsed.children)
			await copyManifest(copy, child.digest, depth + 1);
		for (const blob of parsed.blobs) await ensureBlob(copy, blob);
		copy.stats.blobsSkipped += parsed.skipped.length;
		await putManifest(copy, digest, digest, loaded.bytes, parsed.mediaType);
		copy.stats.manifestsPut++;
		return true;
	}

	/** The subject's referrers at the source: referrers API, then tag fallback. */
	async function sourceReferrers(
		copy: Copy,
		digest: string,
	): Promise<readonly Descriptor[]> {
		const source = copy.source;
		if (!source) return [];
		const scopes = pull(source.repository);
		const response = await source.session.send({
			method: "GET",
			path: `/v2/${source.repository}/referrers/${digest}`,
			scopes,
			headers: { accept: OCI_IMAGE_INDEX },
			maxResponseBytes: MAX_MANIFEST_BYTES,
		});
		if (response.status === 200) return parseReferrers(textOf(response.body));
		if (response.status !== 404)
			unexpected(response, `GET referrers of ${digest}`);
		const fallback = await getManifest(
			source.session,
			source.repository,
			referrersFallbackTag(digest),
			scopes,
		);
		return fallback ? parseReferrers(fallback.text) : [];
	}

	async function referrersDiscoverable(
		copy: Copy,
		subject: string,
		expected: readonly string[],
	): Promise<boolean> {
		const response = await copy.target.send({
			method: "GET",
			path: `/v2/${copy.repository}/referrers/${subject}`,
			scopes: push(copy.repository),
			headers: { accept: OCI_IMAGE_INDEX },
			maxResponseBytes: MAX_MANIFEST_BYTES,
		});
		if (response.status === 404) return false;
		if (response.status !== 200)
			unexpected(response, `GET referrers of ${subject}`);
		const listed = new Set(
			parseReferrers(textOf(response.body)).map((entry) => entry.digest),
		);
		return expected.every((digest) => listed.has(digest));
	}

	async function ensureTag(
		copy: Copy,
		tag: string,
		digest: string,
		manifest: () => Promise<{ bytes: Uint8Array; mediaType: string }>,
	): Promise<"noop" | "set"> {
		const state = await headManifest(
			copy.target,
			copy.repository,
			tag,
			push(copy.repository),
		);
		if (state.present && state.digest === digest) return "noop";
		const { bytes, mediaType } = await manifest();
		await putManifest(copy, tag, digest, bytes, mediaType);
		return "set";
	}

	async function observe(
		target: Target,
		session: RegistrySession,
		scopes: readonly string[],
	): Promise<{ present: boolean; outputs: JsonObject }> {
		const manifest = await headManifest(
			session,
			target.repository,
			target.digest,
			scopes,
		);
		const tagDigests: JsonObject[] = [];
		let tagsConverged = true;
		for (const tag of target.tags) {
			const state = await headManifest(session, target.repository, tag, scopes);
			const at = state.present ? state.digest : "absent";
			if (at !== target.digest) tagsConverged = false;
			tagDigests.push({ tag, digest: at });
		}
		const ready = manifest.present && tagsConverged;
		return {
			present: manifest.present,
			outputs: {
				registry: registry.host,
				repository: target.repository,
				digest: target.digest,
				artifactDigest: target.digest,
				reference: target.physicalId,
				tagDigests,
				manifestPresent: manifest.present,
				tagsConverged,
				ready,
				operationConfirmed: ready,
				operationTerminal: ready,
				absenceConfirmed: false,
				lifecycleStatus: ready ? "ready" : "pending",
			},
		};
	}

	function outcome(
		action: ResolveOutcome["action"],
		target: Target,
		outputs: JsonObject,
		diagnostics: readonly string[],
	): ResolveOutcome {
		return {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: target.physicalId,
			outputs,
			diagnostics,
		};
	}

	const resolver: ResourceResolver = {
		providerId: OCI_REGISTRY_PROVIDER_ID,
		productId: OCI_REGISTRY_IMAGE_PRODUCT_ID,
		directives: ["copyReferrers"],
		read: (raw, transport) =>
			settled(async () => {
				const target = parseTarget(raw);
				const session = await targetSession(target, transport);
				const observed = await observe(
					target,
					session,
					pull(target.repository),
				);
				return observed.present
					? outcome("noop", target, observed.outputs, [])
					: undefined;
			}),
		reconcile: (raw, transport) =>
			settled(async () => {
				const target = parseTarget(raw);
				const session = await targetSession(target, transport);
				const copy = await copyContext(target, session, transport);
				const created = await copyManifest(copy, target.digest, 0);
				let manifestBytes: { bytes: Uint8Array; mediaType: string } | undefined;
				const manifest = async () => {
					if (manifestBytes) return manifestBytes;
					const fetched = await getManifest(
						session,
						target.repository,
						target.digest,
						push(target.repository),
					);
					if (!fetched)
						rejected(
							`manifest ${target.digest} vanished from the target mid-reconcile`,
						);
					const mediaType =
						manifestMediaType(fetched.mediaType) ??
						parseManifest(fetched.text, fetched.mediaType).mediaType;
					manifestBytes = { bytes: fetched.bytes, mediaType };
					return manifestBytes;
				};
				const moved: string[] = [];
				for (const tag of target.tags)
					if ((await ensureTag(copy, tag, target.digest, manifest)) === "set")
						moved.push(tag);
				const diagnostics: string[] = [];
				const referrers: string[] = [];
				let referrersCopied = 0;
				if (target.copyReferrers && copy.source) {
					const listed = await sourceReferrers(copy, target.digest);
					for (const entry of listed) {
						if (await copyManifest(copy, entry.digest, 1)) referrersCopied++;
						referrers.push(entry.digest);
					}
				}
				const observed = await observe(
					target,
					session,
					push(target.repository),
				);
				if (!observed.present || observed.outputs.ready !== true)
					rejected(
						`${target.physicalId} or a declared tag is not observed converged after the writes`,
						"another writer may hold a declared tag; re-run reconcile to observe and converge",
					);
				let outputs = observed.outputs;
				if (referrers.length > 0) {
					const sorted = [...new Set(referrers)].sort();
					const discoverable = await referrersDiscoverable(
						copy,
						target.digest,
						sorted,
					);
					outputs = {
						...outputs,
						referrers: sorted,
						referrersDiscoverable: discoverable,
					};
					if (!discoverable)
						diagnostics.push(
							"referrers are stored by digest but the target lists none for the subject; it lacks the OCI 1.1 referrers API",
						);
				}
				const { stats } = copy;
				if (created || moved.length > 0 || referrersCopied > 0)
					diagnostics.unshift(
						`manifests put ${stats.manifestsPut}; blobs present ${stats.blobsPresent}, mounted ${stats.blobsMounted}, uploaded ${stats.blobsUploaded}, non-distributable skipped ${stats.blobsSkipped}; tags set ${moved.length ? moved.join(",") : "none"}; referrers copied ${referrersCopied}`,
					);
				const action = created
					? "create"
					: moved.length > 0 || referrersCopied > 0
						? "update"
						: target.request.ref.physicalId === undefined
							? "adopt"
							: "noop";
				return outcome(action, target, outputs, diagnostics);
			}),
		delete: (raw, transport) =>
			settled(async () => {
				const target = parseTarget(raw);
				const session = await targetSession(target, transport);
				const scopes = [`repository:${target.repository}:pull,push,delete`];
				const remove = async (reference: string): Promise<void> => {
					let response: TransportResponse | undefined;
					try {
						response = await session.send({
							method: "DELETE",
							path: `/v2/${target.repository}/manifests/${reference}`,
							scopes,
						});
					} catch (error) {
						if (!(error instanceof Error) || !sentButUnknown(error))
							throw error;
					}
					if (response?.status === 405 || response?.status === 400)
						rejected(
							`registry ${registry.host} does not delete ${isDigest(reference) ? "manifests" : "tags"} through the distribution API`,
							"remove it with the registry's own retention tooling, or leave it and drop it from the declared state",
						);
					if (
						response !== undefined &&
						![200, 202, 204, 404].includes(response.status)
					)
						unexpected(response, `DELETE ${reference}`);
				};
				for (const tag of target.tags) {
					const state = await headManifest(
						session,
						target.repository,
						tag,
						scopes,
					);
					// A tag that now points elsewhere is no longer ours to remove.
					if (!state.present || state.digest !== target.digest) continue;
					await remove(tag);
					const after = await headManifest(
						session,
						target.repository,
						tag,
						scopes,
					);
					if (after.present && after.digest === target.digest)
						rejected(
							`tag ${tag} is still observed at ${target.digest} after delete`,
						);
				}
				if (options.allowManifestDelete === true) {
					await remove(target.digest);
					const after = await headManifest(
						session,
						target.repository,
						target.digest,
						scopes,
					);
					if (after.present)
						rejected(
							`manifest ${target.digest} is still observed after delete`,
						);
				}
			}),
	};
	return Object.freeze([resolver]);
}

/** Registry of the OCI registry realizer, instrumented when a sink is bound. */
export function ociRegistryResolverRegistry(
	options: OciRegistryResolverOptions,
) {
	return createResolverRegistry(
		instrumentResolvers(createOciRegistryResolvers(options), options),
	);
}

function parseTags(value: JsonValue | undefined): readonly string[] {
	if (value === undefined) return [];
	if (!isJsonArray(value) || value.length > MAX_TAGS)
		rejected(`desired.tags must be an array of at most ${MAX_TAGS} tags`);
	const tags: string[] = [];
	for (const entry of value) {
		if (!isJsonString(entry) || !isTag(entry))
			rejected("desired.tags holds a value that is not a distribution tag");
		if (isDigest(entry.replace("-", ":")) && entry.startsWith("sha256-"))
			rejected(
				`desired.tags names ${entry}, the referrers fallback tag`,
				"that tag belongs to the referrers protocol, not to a promotion",
			);
		if (tags.includes(entry)) rejected(`desired.tags lists ${entry} twice`);
		tags.push(entry);
	}
	return Object.freeze([...tags].sort());
}

function endpoint(
	value: OciRegistryEndpoint,
	field: string,
): OciRegistryEndpoint {
	const invalid = (why: string): never => {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${field}: ${why}`,
			OCI_REGISTRY_IMAGE_PRODUCT_ID,
		);
	};
	if (!isJsonString(value?.host) || !isRegistryHost(value.host))
		invalid("host must be a bare lowercase DNS name (no scheme, port or path)");
	for (const realm of value.authRealms ?? []) {
		let url: URL;
		try {
			url = new URL(realm);
		} catch {
			return invalid("authRealms entries must be plain https URLs");
		}
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.port
		)
			invalid("authRealms entries must be plain https URLs");
	}
	for (const host of value.blobRedirectHosts ?? [])
		if (!isRegistryHost(host))
			invalid("blobRedirectHosts entries must be bare DNS names");
	return Object.freeze({
		host: value.host,
		authRealms: Object.freeze([...(value.authRealms ?? [])]),
		blobRedirectHosts: Object.freeze([...(value.blobRedirectHosts ?? [])]),
		credentialRef:
			value.credentialRef === undefined
				? undefined
				: locator(value.credentialRef, invalid),
	});
}

/** A source credential is named by a locator, never carried (I9). */
function locator(value: string, invalid: (why: string) => never): string {
	if (
		!isJsonString(value) ||
		value.length > 512 ||
		!/^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9\-._~:/?#[\]!$&'()*+,;=%]+$/u.test(value)
	)
		invalid(
			"credentialRef must be a scheme://… locator, never credential material",
		);
	return value;
}

/** Manifest or index bytes as JSON text; a manifest is UTF-8 by definition. */
function manifestText(bytes: Uint8Array, what: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		return unparseable(`manifest ${what} is not UTF-8`);
	}
}

function bounded(
	value: number | undefined,
	fallback: number,
	field: string,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${field} must be a positive integer`,
			OCI_REGISTRY_IMAGE_PRODUCT_ID,
		);
	return value;
}

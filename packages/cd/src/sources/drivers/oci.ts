// OCI_REPOSITORY subscriptions over the OCI distribution API (no registry
// SDK, no runtime): tags list with Link pagination, manifest digest via HEAD
// (`Docker-Content-Digest`, else sha256 over the manifest read), manifest
// annotations for commit/created when assembly or selection needs them, the
// referrers API (with the `sha256-<hex>` tag-schema fallback) for
// attestations, and the `WWW-Authenticate` bearer-token flow.
//
// Locator: `<registry host>[:port]/<repository>`; `docker.io/x` reads
// `registry-1.docker.io/library/x`.
import { create } from "@bufbuild/protobuf";
import type { HttpTransport, JsonValue, TransportResponse } from "@hobo/core";
import {
	ArtifactKind,
	ArtifactRefSchema,
	SelectionStrategy,
	SubscriptionKind,
	type SubscriptionRecord,
} from "../../_generated/cd_pb.js";
import type { CdContext, CredentialResolver, Outcome } from "../../ports.js";
import {
	credentialHeaders,
	fetchSource,
	header,
	redactUrl,
	type SourceRequest,
	upstreamInvalid,
} from "../http.js";
import {
	encode,
	field,
	isDigest,
	isRecord,
	isText,
	latin1Bytes,
	list,
	parseJson,
	sha256Hex,
	text,
} from "../json.js";
import { refuse, SOURCE_REASON } from "../reasons.js";
import type { AttestationMaterial, AttestingDriver } from "../types.js";
import { type Candidate, discovered, selectCandidates } from "./common.js";

// public-contract: manifest media types the driver asks for.
export const OCI_MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
// public-contract: referrer artifact types read as attestations.
export const OCI_ATTESTATION_TYPES = Object.freeze([
	"application/vnd.dev.sigstore.bundle.v0.3+json",
	"application/vnd.dev.sigstore.bundle+json;version=0.3",
	"application/vnd.dev.sigstore.bundle.v0.2+json",
	"application/vnd.in-toto+json",
] as const);
// public-contract: OCI image-spec pre-defined annotation key for the source revision.
export const OCI_REVISION_ANNOTATION = "org.opencontainers.image.revision";
// public-contract: OCI image-spec pre-defined annotation key for the build time.
export const OCI_CREATED_ANNOTATION = "org.opencontainers.image.created";
/** Bounds per discovery: tag pages, manifest reads for NEWEST_BUILD, referrers. */
export const OCI_MAX_TAG_PAGES = 50;
export const OCI_MAX_MANIFEST_READS = 100;
export const OCI_MAX_REFERRERS = 16;

const REPOSITORY =
	/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export type OciLocator = Readonly<{
	host: string;
	repository: string;
	display: string;
}>;

export function parseOciLocator(locator: string): Outcome<OciLocator> {
	const slash = locator.indexOf("/");
	const host = slash > 0 ? locator.slice(0, slash) : "";
	let repository = slash > 0 ? locator.slice(slash + 1) : "";
	if (
		!HOST.test(host) ||
		!host.includes(".") ||
		!REPOSITORY.test(repository) ||
		locator.includes("://")
	) {
		return refuse(
			SOURCE_REASON.invalid,
			`OCI locator ${JSON.stringify(locator)} is not <registry host>/<repository>`,
			"write the repository as registry.example.com/team/app (no scheme, tag or digest)",
			"locator",
		);
	}
	let registry = host;
	if (host === "docker.io" || host === "index.docker.io") {
		registry = "registry-1.docker.io";
		if (!repository.includes("/")) repository = `library/${repository}`;
	}
	return {
		ok: true,
		value: {
			host: registry,
			repository,
			display: `${host}/${slash > 0 ? locator.slice(slash + 1) : ""}`,
		},
	};
}

type Challenge = Readonly<{
	scheme: "bearer" | "basic";
	realm: string;
	service: string;
	scope: string;
}>;

export function parseChallenge(
	value: string | undefined,
): Challenge | undefined {
	if (!value) return undefined;
	const match = /^\s*(Bearer|Basic)\b(.*)$/i.exec(value);
	if (!match) return undefined;
	const params = new Map<string, string>();
	for (const item of (match[2] ?? "").matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
		if (item[1] && item[2] !== undefined)
			params.set(item[1].toLowerCase(), item[2]);
	}
	return {
		scheme: match[1]?.toLowerCase() === "basic" ? "basic" : "bearer",
		realm: params.get("realm") ?? "",
		service: params.get("service") ?? "",
		scope: params.get("scope") ?? "",
	};
}

/** Bytes of a body whose sha256 must equal `digest`: latin1 first, then UTF-8. */
export function digestBytes(
	body: string,
	digest: string,
): Uint8Array | undefined {
	const raw = latin1Bytes(body);
	if (raw && `sha256:${sha256Hex(raw)}` === digest) return raw;
	const text8 = encode(body);
	return `sha256:${sha256Hex(text8)}` === digest ? text8 : undefined;
}

type TokenEntry = Readonly<{ token: string; expiresAtMs: number }>;

/** One registry session: auth challenge handling and an in-memory token cache. */
class Registry {
	/** Authorization obtained for this session; sent up front on later reads. */
	private authorization: string | undefined;

	constructor(
		private readonly http: HttpTransport,
		private readonly credentials: CredentialResolver | undefined,
		private readonly tokens: Map<string, TokenEntry>,
		private readonly subscription: SubscriptionRecord,
		private readonly locator: OciLocator,
		private readonly ctx: CdContext,
	) {}

	url(path: string): string {
		return `https://${this.locator.host}/v2/${this.locator.repository}${path}`;
	}

	private sessionKey(): string {
		return `session|${this.locator.host}/${this.locator.repository}|${this.subscription.credentialRef}`;
	}

	private tokenKey(challenge: Challenge): string {
		return `${challenge.realm}|${challenge.service}|${challenge.scope}|${this.subscription.credentialRef}`;
	}

	private async authorize(challenge: Challenge): Promise<Outcome<string>> {
		const auth = await credentialHeaders(
			this.credentials,
			this.subscription.credentialRef,
		);
		if (!auth.ok) return auth;
		if (challenge.scheme === "basic") {
			const value = auth.value.authorization;
			return value
				? { ok: true, value }
				: refuse(
						SOURCE_REASON.authFailed,
						`${this.locator.display} requires basic credentials`,
						"set the subscription credentialRef",
						this.locator.display,
					);
		}
		const cached = this.tokens.get(this.tokenKey(challenge));
		if (cached && cached.expiresAtMs > this.ctx.now())
			return { ok: true, value: `Bearer ${cached.token}` };
		let realm: URL;
		try {
			realm = new URL(challenge.realm);
		} catch {
			return upstreamInvalid(
				this.locator.display,
				"WWW-Authenticate realm is not a URL",
			);
		}
		if (realm.protocol !== "https:")
			return upstreamInvalid(this.locator.display, "token realm is not https");
		if (challenge.service) realm.searchParams.set("service", challenge.service);
		if (challenge.scope) realm.searchParams.set("scope", challenge.scope);
		const response = await fetchSource(
			this.http,
			{
				url: realm.toString(),
				headers: { ...auth.value, accept: "application/json" },
			},
			this.ctx.now(),
		);
		if (!response.ok) return response;
		const document = parseJson(response.value.body);
		const token = text(document, "token") ?? text(document, "access_token");
		if (!token)
			return upstreamInvalid(
				redactUrl(realm.toString()),
				"token response has no token",
			);
		const expires = field(document, "expires_in");
		const ttlMs =
			Number.isFinite(Number(expires)) && Number(expires) > 0
				? Number(expires) * 1000
				: 60_000;
		this.tokens.set(this.tokenKey(challenge), {
			token,
			expiresAtMs: this.ctx.now() + ttlMs - 5_000,
		});
		return { ok: true, value: `Bearer ${token}` };
	}

	/** Read with one auth round-trip on a 401 challenge. */
	async read(request: SourceRequest): Promise<Outcome<TransportResponse>> {
		const accept = [...(request.accept ?? []), 401];
		const remembered = this.tokens.get(this.sessionKey());
		if (
			!this.authorization &&
			remembered &&
			remembered.expiresAtMs > this.ctx.now()
		)
			this.authorization = remembered.token;
		const headers = this.authorization
			? { ...request.headers, authorization: this.authorization }
			: (request.headers ?? {});
		const first = await fetchSource(
			this.http,
			{ ...request, headers, accept },
			this.ctx.now(),
		);
		if (
			!first.ok ||
			first.value.status !== 401 ||
			request.accept?.includes(401)
		)
			return first;
		const challenge = parseChallenge(header(first.value, "www-authenticate"));
		if (!challenge) {
			return refuse(
				SOURCE_REASON.authFailed,
				`${this.locator.display} refused the read (401)`,
				"set the subscription credentialRef",
				this.locator.display,
			);
		}
		const authorization = await this.authorize(challenge);
		if (!authorization.ok) return authorization;
		this.authorization = authorization.value;
		this.tokens.set(this.sessionKey(), {
			token: authorization.value,
			expiresAtMs: this.ctx.now() + 60_000,
		});
		const second = await fetchSource(
			this.http,
			{
				...request,
				headers: {
					...request.headers,
					authorization: authorization.value,
				},
			},
			this.ctx.now(),
		);
		return second;
	}

	async tags(): Promise<Outcome<readonly string[]>> {
		const tags: string[] = [];
		let next: string | undefined = this.url("/tags/list?n=1000");
		for (
			let page = 0;
			next !== undefined && page < OCI_MAX_TAG_PAGES;
			page += 1
		) {
			const response = await this.read({
				url: next,
				headers: { accept: "application/json" },
			});
			if (!response.ok) return response;
			const names = list(parseJson(response.value.body), "tags");
			for (const name of names)
				if (isText(name) && TAG.test(name)) tags.push(name);
			const link = header(response.value, "link");
			const target = link
				? /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link)?.[1]
				: undefined;
			next = target
				? new URL(target, `https://${this.locator.host}`).toString()
				: undefined;
			if (next && new URL(next).host !== this.locator.host) {
				return upstreamInvalid(
					this.locator.display,
					"tags pagination points at another host",
				);
			}
		}
		return { ok: true, value: tags };
	}

	async manifestDigest(reference: string): Promise<Outcome<string>> {
		const head = await this.read({
			method: "HEAD",
			url: this.url(`/manifests/${reference}`),
			headers: { accept: OCI_MANIFEST_ACCEPT },
		});
		if (!head.ok) return head;
		const digest = header(head.value, "docker-content-digest");
		if (digest && isDigest(digest)) return { ok: true, value: digest };
		const manifest = await this.manifest(reference);
		return manifest.ok ? { ok: true, value: manifest.value.digest } : manifest;
	}

	async manifest(
		reference: string,
	): Promise<
		Outcome<
			Readonly<{ digest: string; document: JsonValue; mediaType: string }>
		>
	> {
		const response = await this.read({
			url: this.url(`/manifests/${reference}`),
			headers: { accept: OCI_MANIFEST_ACCEPT },
		});
		if (!response.ok) return response;
		const document = parseJson(response.value.body);
		if (!isRecord(document))
			return upstreamInvalid(
				this.locator.display,
				`manifest ${reference} is not JSON`,
			);
		const claimed = header(response.value, "docker-content-digest");
		const computed = `sha256:${sha256Hex(latin1Bytes(response.value.body) ?? encode(response.value.body))}`;
		const digest = isDigest(reference)
			? reference
			: claimed && isDigest(claimed)
				? claimed
				: computed;
		if (!digestBytes(response.value.body, digest)) {
			return upstreamInvalid(
				this.locator.display,
				`manifest ${reference} does not hash to ${digest}`,
			);
		}
		return {
			ok: true,
			value: {
				digest,
				document,
				mediaType:
					text(document, "mediaType") ??
					header(response.value, "content-type") ??
					"",
			},
		};
	}

	async blob(digest: string, maxBytes: number): Promise<Outcome<Uint8Array>> {
		const response = await this.read({
			url: this.url(`/blobs/${digest}`),
			headers: { accept: "application/octet-stream" },
			maxResponseBytes: maxBytes,
		});
		if (!response.ok) return response;
		const bytes = digestBytes(response.value.body, digest);
		return bytes
			? { ok: true, value: bytes }
			: upstreamInvalid(
					this.locator.display,
					`blob ${digest} does not hash to its digest`,
				);
	}

	async referrers(
		digest: string,
	): Promise<
		Outcome<readonly Readonly<{ digest: string; artifactType: string }>[]>
	> {
		const response = await this.read({
			url: this.url(`/referrers/${digest}`),
			headers: { accept: "application/vnd.oci.image.index.v1+json" },
			accept: [404],
		});
		if (!response.ok) return response;
		let index: JsonValue | undefined = parseJson(response.value.body);
		if (response.value.status === 404) {
			const fallback = await this.read({
				url: this.url(`/manifests/${digest.replace(":", "-")}`),
				headers: { accept: "application/vnd.oci.image.index.v1+json" },
				accept: [404],
			});
			if (!fallback.ok) return fallback;
			index =
				fallback.value.status === 404
					? { manifests: [] }
					: parseJson(fallback.value.body);
		}
		return {
			ok: true,
			value: list(index, "manifests").flatMap((entry) => {
				const ref = text(entry, "digest");
				const artifactType = text(entry, "artifactType") ?? "";
				return ref && isDigest(ref) ? [{ digest: ref, artifactType }] : [];
			}),
		};
	}
}

function annotation(document: JsonValue, key: string): string | undefined {
	return text(field(document, "annotations"), key);
}

/** Statement bytes from a Sigstore bundle (DSSE payload) or a bare statement/envelope. */
export function attestationOf(
	bytes: Uint8Array,
	artifactType: string,
): AttestationMaterial | undefined {
	const document = parseJson(new TextDecoder().decode(bytes));
	const envelope = field(document, "dsseEnvelope") ?? document;
	const payload = text(envelope, "payload");
	const statement = payload
		? new Uint8Array(Buffer.from(payload, "base64"))
		: bytes;
	if (artifactType.includes("sigstore.bundle")) {
		return payload ? { statement, bundle: bytes } : undefined;
	}
	return { statement };
}

export function createOciDriver(
	d: Readonly<{ http: HttpTransport; credentials?: CredentialResolver }>,
): AttestingDriver {
	const tokens = new Map<string, TokenEntry>();
	const session = (
		subscription: SubscriptionRecord,
		locator: OciLocator,
		ctx: CdContext,
	) => new Registry(d.http, d.credentials, tokens, subscription, locator, ctx);
	return {
		kind: SubscriptionKind.OCI_REPOSITORY,
		async discover(input, ctx) {
			const { subscription } = input;
			const locator = parseOciLocator(subscription.locator);
			if (!locator.ok) return locator;
			const registry = session(subscription, locator.value, ctx);
			const tags = await registry.tags();
			if (!tags.ok) return tags;
			const newestBuild =
				subscription.selection === SelectionStrategy.NEWEST_BUILD;
			const placeholders: Candidate[] = [];
			const documents = new Map<
				string,
				Readonly<{ digest: string; document: JsonValue }>
			>();
			if (newestBuild) {
				const filtered = selectCandidates(
					{
						...subscription,
						selection: SelectionStrategy.LEXICAL,
						discoveryLimit: OCI_MAX_MANIFEST_READS,
					},
					tags.value.map((tag) => ({
						version: tag,
						rank: tag,
						artifact: create(ArtifactRefSchema, {}),
					})),
					undefined,
				);
				for (const candidate of filtered.selected) {
					const manifest = await registry.manifest(candidate.version);
					// A tag deleted between list and read is simply not a candidate.
					if (
						!manifest.ok &&
						manifest.reasons[0]?.code === SOURCE_REASON.notFound
					)
						continue;
					if (!manifest.ok) return manifest;
					const created = annotation(
						manifest.value.document,
						OCI_CREATED_ANNOTATION,
					);
					if (!created || Number.isNaN(Date.parse(created))) continue;
					documents.set(candidate.version, manifest.value);
					placeholders.push({
						...candidate,
						rank: `${new Date(created).toISOString()}\u0000${candidate.version}`,
					});
				}
			} else {
				for (const tag of tags.value)
					placeholders.push({
						version: tag,
						rank: tag,
						artifact: create(ArtifactRefSchema, {}),
					});
			}
			const picked = selectCandidates(subscription, placeholders, input.cursor);
			const artifacts = [];
			for (const candidate of picked.selected) {
				// The tag resolves to a digest by HEAD; the manifest is then read by that
				// immutable digest (and must hash to it) for its revision annotation.
				let read = documents.get(candidate.version);
				if (!read) {
					const head = await registry.manifestDigest(candidate.version);
					if (!head.ok) return head;
					const manifest = await registry.manifest(head.value);
					if (!manifest.ok) return manifest;
					read = manifest.value;
				}
				const { digest, document } = read;
				const revision = annotation(document, OCI_REVISION_ANNOTATION);
				const artifact = create(ArtifactRefSchema, {
					name: subscription.artifactName || subscription.name,
					kind: subscription.artifactKind || ArtifactKind.OCI_IMAGE,
					digest,
					coordinate: `${locator.value.display}@${digest}`,
					mediaType: text(document, "mediaType") ?? "",
					ecosystem: "oci",
				});
				const item: Candidate = { ...candidate, artifact };
				artifacts.push(
					discovered(
						input,
						revision && COMMIT.test(revision)
							? { ...item, commit: revision }
							: item,
						ctx,
					),
				);
			}
			return { ok: true, value: { artifacts, cursor: picked.cursor } };
		},
		async attestations(input, ctx) {
			const locator = parseOciLocator(input.subscription.locator);
			if (!locator.ok) return locator;
			const digest = input.artifact.artifact?.digest ?? "";
			if (!isDigest(digest))
				return upstreamInvalid(
					locator.value.display,
					"discovered artifact has no digest",
				);
			const registry = session(input.subscription, locator.value, ctx);
			const referrers = await registry.referrers(digest);
			if (!referrers.ok) return referrers;
			const materials: AttestationMaterial[] = [];
			const wanted = referrers.value
				.filter((item) =>
					OCI_ATTESTATION_TYPES.some((type) => type === item.artifactType),
				)
				.slice(0, OCI_MAX_REFERRERS);
			for (const referrer of wanted) {
				const manifest = await registry.manifest(referrer.digest);
				if (!manifest.ok) return manifest;
				const layer = list(manifest.value.document, "layers")[0];
				const layerDigest = text(layer, "digest");
				if (!layerDigest || !isDigest(layerDigest)) continue;
				const blob = await registry.blob(layerDigest, 4 * 1024 * 1024);
				if (!blob.ok) return blob;
				const material = attestationOf(blob.value, referrer.artifactType);
				if (material) materials.push(material);
			}
			return { ok: true, value: materials };
		},
	};
}

/**
 * npm package-version realizer (plan 0024, HoBo.CD; D6, R2).
 *
 * The resource is one published version of one package on one npm-compatible
 * registry, plus the dist-tag desired state points at it. It is realized
 * through the existing `ResourceResolver` port and talks HTTP only through the
 * host's `HttpTransport`, wrapped in `guardTransport` pinned to the bound
 * registry.
 *
 * - **converge** (`reconcile`): read the tarball from the artifact store by
 *   the Freight digest, observe the packument, and then exactly one of:
 *   - version absent → `PUT /<name>` with the npm publish document (tarball
 *     attachment, explicit dist-tag, Sigstore provenance attachment when the
 *     Freight carries one);
 *   - version present with matching `dist.integrity` → already converged on
 *     the bytes; only the dist-tag may move (`PUT /-/package/<name>/dist-tags/<tag>`);
 *   - version present with different bytes, or published and later
 *     unpublished → `NpmVersionConflictError`. Versions are immutable.
 *   Every mutation is followed by an observation, and convergence is reported
 *   only from that observation (I5). A lost reply, a timeout or a 5xx is an
 *   ambiguous outcome and is resolved the same way.
 * - **observe** (`read`): `GET /<name>`, compare `dist.integrity`/`dist.shasum`
 *   and `dist-tags`.
 * - **delete**: deprecate the version (`PUT /<name>` with the packument whose
 *   version carries `deprecated`). Unpublish is refused by policy.
 *
 * Dist-tags are the promotion lever: promoting the same Freight from a
 * `candidate` channel to `stable` is a reconcile with a different `distTag`,
 * which moves a pointer and never republishes (I1).
 *
 * Credentials: `credentialRef` resolves through the host to either a registry
 * token or, in `oidc-trusted-publishing` mode, the CI's OIDC ID token, which
 * is exchanged at `POST /-/npm/v1/oidc/token/exchange/package/<name>` for a
 * short-lived publish token. Neither ever reaches an outcome, an error or a
 * record (I9).
 *
 * Scoped names travel unescaped (`/@scope/name`) because the transport guard
 * refuses `%2f` in paths, while npm's own client sends `@scope%2fname`. Probed
 * against registry.npmjs.org on 2026-11-12 (README "Scoped names"): packument
 * and dist-tag reads route both forms identically, and dist-tag PUTs reach the
 * same auth check in both forms; the OIDC exchange routes only the escaped
 * form (unescaped is a route-level 404), so trusted publishing of a scoped
 * name is refused here as an impedance limit. A successful unescaped publish
 * or dist-tag move is not yet captured; the opt-in live lane exercises it.
 *
 * Reads that confirm a mutation use `?write=true`: npmjs serves plain packument
 * GETs from its CDN (`cache-control: public, max-age=300`), so a plain read can
 * miss a publish that landed; `?write=true` reaches the origin uncached.
 */
import {
	createResolverRegistry,
	guardTransport,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	type ResolverAction,
	ResolverError,
	type ResourceResolver,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";
import {
	fail,
	NPM_PACKAGE_VERSION_PRODUCT_ID,
	NPM_PROVIDER_ID,
	NpmOtpRequiredError,
	NpmVersionConflictError,
	npmProductRefusal,
	reject,
	unparseable,
	unsupported,
} from "./errors.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	type NpmProvenanceAttachment,
	parseProvenanceBundle,
} from "./provenance.js";
import {
	NPM_MAX_RESPONSE_BYTES,
	NPM_TIMEOUT_MS,
	type NpmRegistryBinding,
	parseNpmRegistryBinding,
} from "./registry.js";
import {
	compareIntegrity,
	type NpmTarball,
	parseNpmTarball,
	parseSha256Digest,
	sha256Of,
} from "./tarball.js";

// public-contract: how the resolved credential authenticates to the registry.
// `anonymous` observes a public package and never resolves a credential: it
// is for Camps that only re-read what another Camp published (`read`); a
// write through it is refused.
export const NPM_AUTH_MODES = Object.freeze([
	"token",
	"oidc-trusted-publishing",
	"anonymous",
] as const);
export type NpmAuthMode = (typeof NPM_AUTH_MODES)[number];

// public-contract: desired-state keys the resolver reads as directives, not identity.
export const NPM_DIRECTIVES = Object.freeze([
	"access",
	"deprecationMessage",
] as const);

// public-contract: the deprecation message used when desired state names none.
export const NPM_DEFAULT_DEPRECATION_MESSAGE =
	"This version was retired by HoBo continuous delivery.";

/**
 * The artifact store blob reader. Structurally the `get` of `@hobo/cd`'s
 * `ArtifactStore`; declared here so a provider package does not depend on the
 * delivery service.
 */
export interface NpmArtifactBlobReader {
	get(digest: string): Promise<Uint8Array | undefined>;
}

/** Registry, auth mode and artifact access are bound by the host, never read from a plan. */
export interface NpmResolverOptions {
	readonly registry: NpmRegistryBinding;
	readonly auth: NpmAuthMode;
	/** Resolves `credentialRef` to a registry token, or to a CI OIDC ID token; never called in `anonymous` mode. */
	readonly resolveCredential: (ref: string) => Promise<string>;
	readonly artifacts: NpmArtifactBlobReader;
}

const DESIRED_KEYS = new Set([
	"registry",
	"packageName",
	"version",
	"distTag",
	"artifactDigest",
	"artifactCoordinate",
	"provenanceDigest",
	"access",
	"deprecationMessage",
]);
const PACKAGE_NAME =
	/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;
// SemVer 2.0.0 without build metadata: npm strips `+build`, so a version that
// carries one would publish under a different string than the one desired.
const VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
// npm refuses tags that parse as a semver range (`1`, `v2`); a leading letter
// that is not `v`+digit keeps every accepted tag unambiguous.
const DIST_TAG = /^(?!v\d)[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const TOKEN = /^[!-~]{1,8192}$/u;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u;

interface Target {
	readonly request: ResolveRequest;
	readonly name: string;
	readonly version: string;
	readonly distTag: string;
	readonly artifactDigest: string;
	readonly provenanceDigest?: string;
	readonly access?: "public" | "restricted";
	readonly deprecationMessage: string;
	readonly physicalId: string;
}

interface Artifact {
	readonly tarball: NpmTarball;
	readonly provenance?: NpmProvenanceAttachment;
}

interface Session {
	send(
		method: TransportMethod,
		path: string,
		body?: string,
	): Promise<TransportResponse | undefined>;
	read(
		path: string,
	): Promise<{ readonly status: number; readonly body?: JsonObject }>;
}

type Judgement =
	| { readonly state: "absent" }
	| {
			readonly state: "present";
			readonly tagged: boolean;
			readonly outputs: JsonObject;
			readonly diagnostics: readonly string[];
	  };

/** Build the resolver for the bound registry. */
export function createNpmResolvers(
	options: NpmResolverOptions,
): readonly ResourceResolver[] {
	const registry = parseNpmRegistryBinding(options.registry);
	if (!NPM_AUTH_MODES.includes(options.auth))
		unsupported(
			`npm auth mode ${JSON.stringify(options.auth)} is not one of ${NPM_AUTH_MODES.join(", ")}`,
			"bind token or oidc-trusted-publishing",
		);
	if (
		options.auth === "oidc-trusted-publishing" &&
		!registry.supportsOidcTrustedPublishing
	)
		unsupported(
			`${registry.kind} has no OIDC trusted-publishing exchange`,
			"bind a registry token credentialRef for this registry",
		);

	function target(raw: ResolveRequest): Target {
		const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
		if (request.ref.productId !== NPM_PACKAGE_VERSION_PRODUCT_ID)
			throw npmProductRefusal(request.ref.productId);
		const desired = request.desired;
		for (const key of Object.keys(desired))
			if (!DESIRED_KEYS.has(key))
				reject(`npm package version does not implement desired.${key}`);
		if (desired.registry !== registry.base)
			reject(
				`npm desired.registry ${JSON.stringify(desired.registry)} differs from the bound registry ${registry.base}`,
				"bind the Camp to the registry the Set targets",
			);
		const name = desired.packageName;
		if (!isJsonString(name) || name.length > 214 || !PACKAGE_NAME.test(name))
			reject(
				"npm desired.packageName must be a valid lowercase npm package name",
			);
		if (registry.requiresScope && !name.startsWith("@"))
			unsupported(
				`${registry.kind} publishes only scoped packages, not ${name}`,
				"name the package @owner/name",
			);
		if (options.auth === "oidc-trusted-publishing" && name.startsWith("@"))
			unsupported(
				`npm OIDC trusted publishing of the scoped package ${name} is not supported: the registry routes the token exchange only for the %2f-escaped name, which the HoBo transport guard refuses`,
				"bind token auth (an automation or granular access token) for scoped packages",
			);
		const version = desired.version;
		if (!isJsonString(version) || !VERSION.test(version))
			reject(
				"npm desired.version must be a SemVer 2.0.0 version without build metadata",
			);
		const distTag = desired.distTag;
		if (!isJsonString(distTag) || !DIST_TAG.test(distTag))
			reject(
				"npm desired.distTag must be set explicitly to a tag name (latest, candidate, stable, ...) that is not a semver range",
			);
		const artifactDigest = parseSha256Digest(
			desired.artifactDigest,
			"artifactDigest",
		);
		if (
			desired.artifactCoordinate !== undefined &&
			(!isJsonString(desired.artifactCoordinate) ||
				!desired.artifactCoordinate.startsWith("store://") ||
				!desired.artifactCoordinate.endsWith(`/${artifactDigest}`))
		)
			reject(
				"npm desired.artifactCoordinate must be the store:// coordinate of desired.artifactDigest",
			);
		const provenanceDigest =
			desired.provenanceDigest === undefined
				? undefined
				: parseSha256Digest(desired.provenanceDigest, "provenanceDigest");
		if (provenanceDigest !== undefined && !registry.supportsProvenance)
			unsupported(
				`${registry.kind} does not accept npm provenance attachments`,
				"publish without provenanceDigest to this registry, or target registry.npmjs.org",
			);
		const access = desired.access;
		if (access !== undefined && access !== "public" && access !== "restricted")
			reject("npm desired.access must be public or restricted");
		const message =
			desired.deprecationMessage ?? NPM_DEFAULT_DEPRECATION_MESSAGE;
		if (
			!isJsonString(message) ||
			message.trim() === "" ||
			message.length > 1024
		)
			reject("npm desired.deprecationMessage must be 1-1024 characters");
		const physicalId = `${name}@${version}`;
		if (
			request.ref.physicalId !== undefined &&
			request.ref.physicalId !== physicalId
		)
			reject(`npm ${physicalId} conflicts with its pinned physical identity`);
		return {
			request,
			name,
			version,
			distTag,
			artifactDigest,
			...(provenanceDigest === undefined ? undefined : { provenanceDigest }),
			...(access === undefined ? undefined : { access }),
			deprecationMessage: message,
			physicalId,
		};
	}

	async function blob(digest: string, what: string): Promise<Uint8Array> {
		const bytes = await options.artifacts.get(digest);
		if (bytes === undefined)
			reject(
				`npm ${what} ${digest} is not in the artifact store`,
				"re-put the build output into the artifact store and re-record the Freight",
			);
		return bytes;
	}

	async function artifact(t: Target): Promise<Artifact> {
		const tarball = parseNpmTarball(
			await blob(t.artifactDigest, "tarball"),
			t.artifactDigest,
		);
		if (
			tarball.manifest.name !== t.name ||
			tarball.manifest.version !== t.version
		)
			reject(
				`npm tarball package.json is ${JSON.stringify(tarball.manifest.name)}@${JSON.stringify(tarball.manifest.version)}, not ${t.physicalId}`,
				"set desired.packageName and desired.version from the tarball the Freight carries",
			);
		if (t.provenanceDigest === undefined) return { tarball };
		const bundle = await blob(t.provenanceDigest, "provenance bundle");
		if (sha256Of(bundle) !== t.provenanceDigest)
			reject(
				"artifact store returned a provenance bundle that does not hash to its digest",
			);
		return {
			tarball,
			provenance: parseProvenanceBundle(bundle, tarball, t.name, t.version),
		};
	}

	async function session(t: Target, supplied: HttpTransport): Promise<Session> {
		const transport = guardTransport(supplied, registry.policy);
		const anonymous = options.auth === "anonymous";
		const credential = anonymous
			? ""
			: await options.resolveCredential(t.request.credentialRef);
		if (!anonymous && (!isJsonString(credential) || !TOKEN.test(credential)))
			fail(
				"RESOLVER_CREDENTIAL_MISSING",
				"npm credential is missing or malformed",
			);

		async function raw(
			method: TransportMethod,
			path: string,
			bearer: string,
			body?: string,
		): Promise<TransportResponse> {
			return transport({
				method,
				url: `${registry.base}${path}`,
				headers: {
					accept: "application/json",
					...(bearer === ""
						? undefined
						: { authorization: `Bearer ${bearer}` }),
					...(body === undefined
						? undefined
						: { "content-type": "application/json" }),
				},
				...(body === undefined ? undefined : { body }),
				timeoutMs: NPM_TIMEOUT_MS,
				maxResponseBytes: NPM_MAX_RESPONSE_BYTES,
			});
		}

		let bearer = credential;
		if (options.auth === "oidc-trusted-publishing") {
			if (!JWT.test(credential))
				fail(
					"RESOLVER_CREDENTIAL_MISSING",
					"npm trusted publishing needs the CI's OIDC ID token behind credentialRef",
				);
			let exchanged: TransportResponse;
			try {
				exchanged = await raw(
					"POST",
					`/-/npm/v1/oidc/token/exchange/package/${t.name}`,
					credential,
				);
			} catch (error) {
				if (error instanceof ResolverError) throw error;
				return reject(
					"npm OIDC token exchange failed in transport",
					"retry the reconcile; the exchange has no side effect",
				);
			}
			if (exchanged.status < 200 || exchanged.status >= 300)
				reject(
					`npm OIDC token exchange returned HTTP ${exchanged.status}`,
					`configure a trusted publisher for ${t.name} on npmjs.com that matches this CI workflow (the package must already exist)`,
				);
			const token = json(exchanged.body).token;
			if (!isJsonString(token) || !TOKEN.test(token))
				unparseable("npm OIDC token exchange returned no publish token");
			bearer = token;
		}

		return {
			async send(method, path, body) {
				try {
					return await raw(method, path, bearer, body);
				} catch (error) {
					if (error instanceof ResolverError) throw error;
					// The request may have reached the registry: ambiguous, so the
					// caller resolves it by observation.
					return undefined;
				}
			},
			async read(path) {
				let response: TransportResponse;
				try {
					response = await raw("GET", path, bearer);
				} catch (error) {
					if (error instanceof ResolverError) throw error;
					return reject(
						"npm registry read failed in transport",
						"retry the reconcile; reads are side-effect free",
					);
				}
				if (response.status === 404) return { status: 404 };
				if (response.status === 401 || response.status === 403)
					authRefusal("the read", response);
				if (response.status < 200 || response.status >= 300)
					reject(
						`npm registry read returned HTTP ${response.status}`,
						"retry the reconcile; reads are side-effect free",
					);
				return { status: response.status, body: json(response.body) };
			},
		};
	}

	/** An anonymous binding reads; it never publishes, tags or deprecates. */
	function observeOnly(what: string): void {
		if (options.auth === "anonymous")
			fail(
				"RESOLVER_CREDENTIAL_MISSING",
				`npm anonymous binding cannot ${what}: it only observes`,
				"bind token or oidc-trusted-publishing auth on a Camp that writes",
			);
	}

	async function packument(s: Session, t: Target, write = false) {
		const read = await s.read(`/${t.name}${write ? "?write=true" : ""}`);
		return read.body;
	}

	function judge(
		t: Target,
		art: Artifact,
		doc: JsonObject | undefined,
	): Judgement {
		if (doc === undefined) return { state: "absent" };
		const versions = isJsonObject(doc.versions) ? doc.versions : {};
		const entry = versions[t.version];
		if (entry === undefined) {
			const time = isJsonObject(doc.time) ? doc.time : {};
			// A package unpublished in its entirety keeps no per-version time
			// entries, only `time.unpublished` (with the version list when the
			// registry records it).
			const unpublished = isJsonObject(time.unpublished)
				? time.unpublished.versions
				: undefined;
			if (
				time[t.version] !== undefined ||
				(isJsonArray(unpublished) && unpublished.includes(t.version))
			)
				throw new NpmVersionConflictError(
					"npm-version-previously-unpublished",
					`${t.physicalId} was published and later unpublished; npm never accepts that version again`,
				);
			return { state: "absent" };
		}
		if (!isJsonObject(entry) || !isJsonObject(entry.dist))
			unparseable(`npm packument version ${t.version} has no dist`);
		const dist = entry.dist;
		if (!isJsonString(dist.integrity))
			reject(
				`npm registry publishes no dist.integrity for ${t.physicalId}; the bytes cannot be compared`,
				"use a registry that records Subresource Integrity",
			);
		const verdict = compareIntegrity(dist.integrity, art.tarball.bytes);
		if (
			verdict === "mismatch" ||
			(isJsonString(dist.shasum) && dist.shasum !== art.tarball.shasum)
		)
			throw new NpmVersionConflictError(
				"npm-version-integrity-mismatch",
				`${t.physicalId} already exists with different bytes than Freight ${t.artifactDigest}`,
			);
		if (verdict === "incomparable")
			reject(
				`npm registry dist.integrity for ${t.physicalId} names no sha256/384/512 hash`,
				"use a registry that records sha512 integrity",
			);
		const tags = isJsonObject(doc["dist-tags"]) ? doc["dist-tags"] : {};
		const tagged = tags[t.distTag] === t.version;
		const deprecated =
			isJsonString(entry.deprecated) && entry.deprecated !== "";
		const provenanceObserved = isJsonObject(dist.attestations);
		const diagnostics: string[] = [];
		if (deprecated)
			diagnostics.push(`${t.physicalId} is deprecated on the registry`);
		if (t.provenanceDigest !== undefined && !provenanceObserved)
			diagnostics.push(
				"the registry has not (yet) indexed provenance attestations for this version",
			);
		const tagValue = tags[t.distTag];
		return {
			state: "present",
			tagged,
			diagnostics,
			outputs: {
				registry: registry.base,
				packageName: t.name,
				version: t.version,
				distTag: t.distTag,
				distTagVersion: isJsonString(tagValue) ? tagValue : null,
				integrity: dist.integrity,
				shasum: isJsonString(dist.shasum) ? dist.shasum : art.tarball.shasum,
				...(isJsonString(dist.tarball)
					? { tarballUrl: dist.tarball }
					: undefined),
				artifactDigest: t.artifactDigest,
				provenanceObserved,
				deprecated,
				ready: tagged,
				operationConfirmed: tagged,
				operationTerminal: tagged,
				absenceConfirmed: false,
				lifecycleStatus: tagged ? "ready" : "pending",
			},
		};
	}

	function outcome(
		action: ResolverAction,
		t: Target,
		judged: Judgement,
	): ResolveOutcome {
		if (judged.state !== "present")
			return unparseable("npm outcome built without an observation");
		return {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: t.physicalId,
			outputs: judged.outputs,
			diagnostics: [...judged.diagnostics],
		};
	}

	function publishDocument(t: Target, art: Artifact): string {
		const unscoped = t.name.replace(/^@[^/]+\//u, "");
		const manifest: JsonObject = {
			...art.tarball.manifest,
			_id: t.physicalId,
			name: t.name,
			version: t.version,
			dist: {
				integrity: art.tarball.integrity,
				shasum: art.tarball.shasum,
				tarball: `${registry.base}/${t.name}/-/${unscoped}-${t.version}.tgz`,
			},
		};
		const provenance = art.provenance;
		const attachments = {
			[`${t.name}-${t.version}.tgz`]: {
				content_type: "application/octet-stream",
				data: Buffer.from(art.tarball.bytes).toString("base64"),
				length: art.tarball.bytes.byteLength,
			},
			...(provenance === undefined
				? undefined
				: {
						[`${t.name}-${t.version}.sigstore`]: {
							content_type: provenance.contentType,
							data: provenance.data,
							length: provenance.data.length,
						},
					}),
		};
		const description = art.tarball.manifest.description;
		return JSON.stringify({
			_id: t.name,
			name: t.name,
			...(isJsonString(description) ? { description } : undefined),
			"dist-tags": { [t.distTag]: t.version },
			versions: { [t.version]: manifest },
			access: t.access ?? null,
			_attachments: attachments,
		});
	}

	/** Issue a mutation; return why it may not have landed, for the observation that follows. */
	async function mutate(
		s: Session,
		method: TransportMethod,
		path: string,
		body: string,
	): Promise<string> {
		const response = await s.send(method, path, body);
		if (response === undefined) return "the reply was lost";
		if (response.status === 401) authRefusal(method, response);
		return `the registry answered HTTP ${response.status}`;
	}

	async function observe(t: Target, transport: HttpTransport) {
		const art = await artifact(t);
		const s = await session(t, transport);
		return { art, s, judged: judge(t, art, await packument(s, t)) };
	}

	const resolver: ResourceResolver = {
		providerId: NPM_PROVIDER_ID,
		productId: NPM_PACKAGE_VERSION_PRODUCT_ID,
		directives: NPM_DIRECTIVES,
		async read(raw, transport) {
			const t = target(raw);
			const { judged } = await observe(t, transport);
			if (judged.state === "absent") return undefined;
			return outcome(
				t.request.ref.physicalId === t.physicalId ? "noop" : "adopt",
				t,
				judged,
			);
		},
		async reconcile(raw, transport) {
			const t = target(raw);
			observeOnly("publish");
			const { art, s, judged: first } = await observe(t, transport);
			let judged = first;
			let action: ResolverAction | undefined;
			if (judged.state === "absent") {
				const sent = await mutate(
					s,
					"PUT",
					`/${t.name}`,
					publishDocument(t, art),
				);
				judged = judge(t, art, await packument(s, t, true));
				if (judged.state === "absent")
					reject(
						`npm publish of ${t.physicalId} is not observable on the registry (${sent})`,
						"check the credential's publish rights; otherwise reconcile again, the next pass adopts or republishes",
					);
				action = "create";
			}
			if (judged.state === "present" && !judged.tagged) {
				const sent = await mutate(
					s,
					"PUT",
					`/-/package/${t.name}/dist-tags/${t.distTag}`,
					JSON.stringify(t.version),
				);
				judged = judge(t, art, await packument(s, t, true));
				if (judged.state !== "present" || !judged.tagged)
					reject(
						`npm dist-tag ${t.distTag} → ${t.version} is not observable on the registry (${sent})`,
						"check the credential's dist-tag rights; otherwise reconcile again",
					);
				action ??= "update";
			}
			action ??= t.request.ref.physicalId === t.physicalId ? "noop" : "adopt";
			return outcome(action, t, judged);
		},
		async delete(raw, transport) {
			const t = target(raw);
			observeOnly("deprecate");
			const art = await artifact(t);
			const s = await session(t, transport);
			const doc = await packument(s, t, true);
			const judged = judge(t, art, doc);
			// Absent is terminal for a deprecate: there is no version to retire.
			if (doc === undefined || judged.state === "absent") return;
			const versions = isJsonObject(doc.versions) ? doc.versions : {};
			const entry = versions[t.version];
			if (!isJsonObject(entry))
				return unparseable(`npm packument version ${t.version} is malformed`);
			if (entry.deprecated === t.deprecationMessage) return;
			const body = JSON.stringify({
				...doc,
				versions: {
					...versions,
					[t.version]: {
						...entry,
						deprecated: t.deprecationMessage,
					},
				},
			});
			const sent = await mutate(s, "PUT", `/${t.name}`, body);
			const after = await packument(s, t, true);
			const afterVersions =
				after && isJsonObject(after.versions) ? after.versions : {};
			const afterEntry = afterVersions[t.version];
			if (
				!isJsonObject(afterEntry) ||
				afterEntry.deprecated !== t.deprecationMessage
			)
				reject(
					`npm deprecation of ${t.physicalId} is not observable on the registry (${sent})`,
					"check the credential's publish rights; otherwise delete again",
				);
		},
	};
	return Object.freeze([resolver]);
}

/**
 * A 401/403 from the registry. `www-authenticate` is parsed the way
 * npm-registry-fetch does (comma-split, case-insensitive): `OTP` means the
 * account enforces 2FA on this write, which no re-issued token of the same
 * kind fixes. A 401 without the challenge whose body asks for a "one-time
 * pass" is the same refusal (npm-registry-fetch's heuristic for older
 * registries). The body is matched, never quoted (I9).
 */
function authRefusal(what: string, response: TransportResponse): never {
	const challenge = Object.entries(response.headers)
		.filter(([name]) => name.toLowerCase() === "www-authenticate")
		.flatMap(([, value]) => value.split(/,\s*/u))
		.map((scheme) => scheme.trim().toLowerCase());
	if (
		challenge.includes("otp") ||
		(response.status === 401 && /one-time pass/iu.test(response.body))
	)
		throw new NpmOtpRequiredError(what);
	return fail(
		"RESOLVER_CREDENTIAL_MISSING",
		`npm registry refused ${what} with HTTP ${response.status}`,
		"re-issue the registry credential behind credentialRef",
	);
}

function json(body: string): JsonObject {
	let value: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this registry boundary.
		value = JSON.parse(body) as JsonValue;
	} catch {
		return unparseable("npm registry returned a non-JSON body");
	}
	if (!isJsonObject(value))
		unparseable("npm registry returned a non-object body");
	return value;
}

/** Registry of every npm product with a shipped resolver. */
export function npmResolverRegistry(options: NpmResolverOptions) {
	return createResolverRegistry(createNpmResolvers(options));
}

/**
 * Offline npm registry world: the npm registry semantics the realizer depends
 * on (packument read, publish-once per version, dist-tag add, deprecate by
 * packument PUT, OIDC exchange), with fault hooks for the ambiguous outcomes.
 * Every request is recorded so tests can assert what reached the "network".
 *
 * Response headers and auth failures follow registry.npmjs.org as captured on
 * 2026-11-12 (see contracts/provider-npm-registry.pact.json metadata):
 * `content-type: application/json` with no charset; packument GETs carry
 * `cache-control: public, max-age=300`, an `etag` and `cf-cache-status`
 * (`HIT` when the CDN served it, `DYNAMIC` for `?write=true`); a bad token is
 * `401` with `www-authenticate: Basic, Bearer` and the body `"Unauthorized"`;
 * a 2FA-enforcing account answers writes with `401` and
 * `www-authenticate: OTP`. With `cdn: true`, plain GETs are served from the
 * first response cached for that path, as the CDN does for up to 300 s, and
 * only `?write=true` reads reach the origin.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
	HttpTransport,
	JsonValue,
	ResolveRequest,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	NPM_PACKAGE_VERSION_PRODUCT_ID,
	type NpmResolverOptions,
} from "../../src/index.js";

export const NAME = "@hobo-fixtures/widget";
export const TOKEN = "npm_fixtureRegistryToken0123456789";
export const ID_TOKEN =
	"eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJucG06cmVnaXN0cnkubnBtanMub3JnIn0.c2lnbmF0dXJl";
export const PUBLISH_TOKEN = "npm_shortLivedPublishToken9876543210";

export function fixture(name: string): Uint8Array {
	return new Uint8Array(
		readFileSync(new URL(`../fixtures/${name}`, import.meta.url)),
	);
}

export function digestOf(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export const TARBALL = fixture("widget-1.2.3.tgz");
export const TARBALL_124 = fixture("widget-1.2.4.tgz");
export const TAMPERED = fixture("widget-1.2.3-tampered.tgz");
/** `npm pack` of the unscoped `hobo-fixtures-widget@1.2.3`. */
export const UNSCOPED_NAME = "hobo-fixtures-widget";
export const UNSCOPED_TARBALL = fixture("unscoped-widget-1.2.3.tgz");

export function memoryStore(...blobs: Uint8Array[]) {
	const map = new Map(blobs.map((bytes) => [digestOf(bytes), bytes]));
	return {
		map,
		async get(digest: string) {
			return map.get(digest);
		},
	};
}

interface VersionDoc {
	name?: string;
	version?: string;
	dist: {
		integrity?: string;
		shasum?: string;
		tarball?: string;
		attestations?: object;
	};
	deprecated?: string;
}

export interface Doc {
	_id?: string;
	_rev?: string;
	name?: string;
	"dist-tags"?: Record<string, string>;
	versions?: Record<string, VersionDoc>;
	time: Record<string, string | Unpublished>;
}

/** `time.unpublished` of a package unpublished in its entirety. */
export interface Unpublished {
	time: string;
	versions?: string[];
}

interface Faults {
	dropReplyOnce: boolean;
	lostBeforeOnce: boolean;
	invisiblePublishOnce: boolean;
	statusOnce: number | undefined;
	appliedStatusOnce: number | undefined;
	otpOnce: boolean;
}

export interface WorldOptions {
	readonly base?: string;
	readonly bearer?: string;
	readonly idToken?: string;
	readonly packument?: Doc;
	/** The package name the world serves; defaults to the scoped fixture. */
	readonly name?: string;
	/** Serve plain GETs from a CDN cache that never expires within a test. */
	readonly cdn?: boolean;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;
const NPM_NOTICE =
	"npm tokens that bypass 2FA are being restricted for account changes and direct publishing. Learn how to prepare: https://gh.io/npm-gat-bypass2fa-deprecation";
export const OTP_BODY = {
	error:
		"This operation requires a one-time password from your authenticator.\nYou can provide a one-time password by passing --otp=<code> to the command you ran.\nIf you already provided a one-time password then it is likely that you either typoed\nit, or it timed out. Please try again.",
};

export function registryWorld(options: WorldOptions = {}) {
	const base = options.base ?? "https://registry.npmjs.org";
	const bearer = options.bearer ?? TOKEN;
	const name = options.name ?? NAME;
	const cache = new Map<string, TransportResponse>();
	const requests: TransportRequest[] = [];
	let packument: Doc | undefined = options.packument
		? structuredClone(options.packument)
		: undefined;
	let rev = 1;
	const faults: Faults = {
		/** Apply the next mutation, then lose its reply. */
		dropReplyOnce: false,
		/** Lose the next mutation before it reaches the registry. */
		lostBeforeOnce: false,
		/** Answer the next publish 200 without making it visible (CDN lag). */
		invisiblePublishOnce: false,
		/** Answer the next mutation with this status, applying nothing. */
		statusOnce: undefined,
		/** Apply the next mutation, then answer with this status (a racing writer). */
		appliedStatusOnce: undefined,
		/** Answer the next mutation with npm's 2FA challenge, applying nothing. */
		otpOnce: false,
	};

	function respond(
		status: number,
		body: Doc | string | Readonly<Record<string, string | boolean>>,
		headers: Readonly<Record<string, string>> = {},
	): TransportResponse {
		return {
			status,
			headers: { ...JSON_HEADERS, ...headers },
			body: JSON.stringify(body),
		};
	}

	function unauthorized(): TransportResponse {
		return respond(401, "Unauthorized", {
			"www-authenticate": "Basic, Bearer",
		});
	}

	function served(doc: Doc, write: boolean): TransportResponse {
		return respond(200, doc, {
			"cache-control": "public, max-age=300",
			etag: `"${createHash("md5").update(JSON.stringify(doc)).digest("hex")}"`,
			"last-modified": "Thu, 12 Nov 2026 00:00:00 GMT",
			"cf-cache-status": write ? "DYNAMIC" : "HIT",
			vary: "accept-encoding, accept",
		});
	}

	function unpublishedVersion(version: string | undefined): boolean {
		const versions = packument?.time?.unpublished;
		const listed = versions instanceof Object ? versions.versions : undefined;
		return version !== undefined && (listed ?? []).includes(version);
	}

	function apply(request: TransportRequest, path: string): TransportResponse {
		const auth = request.headers.authorization;
		if (path.startsWith("/-/npm/v1/oidc/token/exchange/package/")) {
			if (request.method !== "POST" || auth !== `Bearer ${options.idToken}`)
				return respond(401, { error: "invalid id token" });
			return respond(201, { token: PUBLISH_TOKEN });
		}
		if (auth !== `Bearer ${bearer}`) return unauthorized();
		if (path === `/${name}` && request.method === "GET")
			return packument
				? served(packument, new URL(request.url).search === "?write=true")
				: respond(404, { error: "Not found" });
		const tagPrefix = `/-/package/${name}/dist-tags/`;
		if (path.startsWith(tagPrefix) && request.method === "PUT") {
			if (!packument) return respond(404, { error: "Not found" });
			const version = JSON.parse(request.body ?? "null");
			if (!packument.versions?.[version])
				return respond(404, { error: "no such version" });
			packument["dist-tags"] ??= {};
			packument["dist-tags"][path.slice(tagPrefix.length)] = version;
			return respond(201, { ok: true });
		}
		if (path === `/${name}` && request.method === "PUT") {
			const doc = JSON.parse(request.body ?? "{}");
			if (doc._attachments) {
				const [version] = Object.keys(doc.versions);
				if (
					packument?.versions?.[version] ||
					packument?.time?.[version] ||
					unpublishedVersion(version)
				)
					return respond(403, {
						error: `You cannot publish over the previously published versions: ${version}.`,
					});
				const tgz = Object.entries(doc._attachments).find(([key]) =>
					key.endsWith(".tgz"),
				);
				const bytes = Buffer.from(tgz?.[1].data ?? "", "base64");
				if (
					createHash("sha512").update(bytes).digest("base64") !==
					doc.versions[version].dist.integrity.slice("sha512-".length)
				)
					return respond(400, { error: "integrity mismatch" });
				if (faults.invisiblePublishOnce) {
					faults.invisiblePublishOnce = false;
					return respond(200, { success: true });
				}
				const sigstore = Object.keys(doc._attachments).some((key) =>
					key.endsWith(".sigstore"),
				);
				packument ??= {
					_id: name,
					name,
					"dist-tags": {},
					versions: {},
					time: {},
				};
				packument.versions ??= {};
				packument.versions[version] = {
					...doc.versions[version],
					dist: {
						...doc.versions[version].dist,
						...(sigstore
							? {
									attestations: {
										url: `${base}/-/npm/v1/attestations/${name}@${version}`,
										provenance: {
											predicateType: "https://slsa.dev/provenance/v1",
										},
									},
								}
							: undefined),
					},
				};
				packument["dist-tags"] = {
					...packument["dist-tags"],
					...doc["dist-tags"],
				};
				packument.time[version] = "2026-11-12T00:00:00.000Z";
				packument._rev = `${++rev}-fixture`;
				return respond(200, { success: true }, { "npm-notice": NPM_NOTICE });
			}
			if (!packument || doc._rev !== packument._rev)
				return respond(409, { error: "revision conflict" });
			packument = { ...doc, _rev: `${++rev}-fixture` };
			return respond(200, { ok: true }, { "npm-notice": NPM_NOTICE });
		}
		return respond(405, { error: "not modelled" });
	}

	const transport: HttpTransport = async (request) => {
		requests.push(request);
		const url = new URL(request.url);
		if (
			`${url.protocol}//${url.host}` !== new URL(base).origin &&
			!request.url.startsWith(base)
		)
			throw new Error(`world: unexpected origin ${url.origin}`);
		const path = url.pathname.slice(
			new URL(base).pathname.replace(/\/$/u, "").length,
		);
		const mutation = request.method !== "GET";
		if (!mutation && options.cdn && url.search === "") {
			const hit = cache.get(path);
			if (hit) return hit;
			const fresh = apply(request, path);
			cache.set(path, fresh);
			return fresh;
		}
		if (mutation && faults.otpOnce) {
			faults.otpOnce = false;
			return respond(401, OTP_BODY, { "www-authenticate": "OTP" });
		}
		if (mutation && faults.lostBeforeOnce) {
			faults.lostBeforeOnce = false;
			throw new Error("socket hang up");
		}
		if (mutation && faults.statusOnce !== undefined) {
			const status = faults.statusOnce;
			faults.statusOnce = undefined;
			return status === 401
				? unauthorized()
				: respond(status, { error: "injected" });
		}
		const response = apply(request, path);
		if (mutation && faults.appliedStatusOnce !== undefined) {
			const status = faults.appliedStatusOnce;
			faults.appliedStatusOnce = undefined;
			return respond(status, { error: "injected after apply" });
		}
		if (mutation && faults.dropReplyOnce) {
			faults.dropReplyOnce = false;
			throw new Error("ETIMEDOUT");
		}
		return response;
	};

	return {
		transport,
		requests,
		faults,
		packument: () => packument,
		/** Replace the origin's packument (another writer), leaving the CDN cache. */
		setPackument: (doc: Doc | undefined) => {
			packument = doc ? structuredClone(doc) : undefined;
		},
		mutations: () =>
			requests.filter(
				(request) =>
					request.method !== "GET" &&
					!request.url.includes("/-/npm/v1/oidc/token/exchange/"),
			).length,
	};
}

/** A packument that already holds `version` with the integrity of `bytes`. */
export function publishedPackument(
	bytes: Uint8Array,
	tags: Record<string, string>,
	version = "1.2.3",
	name = NAME,
): Doc & { versions: Record<string, VersionDoc> } {
	return {
		_id: name,
		_rev: "1-fixture",
		name,
		"dist-tags": tags,
		versions: {
			[version]: {
				name,
				version,
				dist: {
					integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
					shasum: createHash("sha1").update(bytes).digest("hex"),
					tarball: `https://registry.npmjs.org/${name}/-/${name.replace(/^@[^/]+\//u, "")}-${version}.tgz`,
				},
			},
		},
		time: { [version]: "2026-11-12T00:00:00.000Z" },
	};
}

/**
 * The packument npmjs serves for a package unpublished in its entirety: no
 * `versions`, no `dist-tags`, no per-version `time` entries, only
 * `time.unpublished` (with the unpublished version list when the registry
 * records it).
 */
export function unpublishedPackument(versions?: string[]): Doc {
	return {
		_id: NAME,
		_rev: "3-fixture",
		name: NAME,
		time: {
			created: "2026-01-01T00:00:00.000Z",
			modified: "2026-01-02T00:00:00.000Z",
			unpublished: {
				time: "2026-01-02T00:00:00.000Z",
				...(versions === undefined ? undefined : { versions }),
			},
		},
	};
}

export function options(
	store: { get(digest: string): Promise<Uint8Array | undefined> },
	overrides: Partial<NpmResolverOptions> = {},
): NpmResolverOptions {
	return {
		registry: { kind: "npmjs" },
		auth: "token",
		resolveCredential: async () => TOKEN,
		artifacts: store,
		...overrides,
	};
}

/** Desired-state overrides; an `undefined` value removes the key. */
export type DesiredOverrides = Readonly<Record<string, JsonValue | undefined>>;

export function request(
	overrides: DesiredOverrides = {},
	physicalId?: string,
): ResolveRequest {
	const desired: Record<string, JsonValue> = {};
	const merged = {
		registry: "https://registry.npmjs.org",
		packageName: NAME,
		version: "1.2.3",
		distTag: "candidate",
		artifactDigest: digestOf(TARBALL),
		...overrides,
	};
	for (const [key, value] of Object.entries(merged))
		if (value !== undefined) desired[key] = value;
	return {
		ref: {
			slot: "service",
			productId: NPM_PACKAGE_VERSION_PRODUCT_ID,
			logicalId: "widget",
			...(physicalId ? { physicalId } : undefined),
		},
		desired,
		credentialRef: "vault://cd/npm/publish",
	};
}

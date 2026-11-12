/**
 * Offline npm registry world: the npm registry semantics the realizer depends
 * on (packument read, publish-once per version, dist-tag add, deprecate by
 * packument PUT, OIDC exchange), with fault hooks for the ambiguous outcomes.
 * Every request is recorded so tests can assert what reached the "network".
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
	"dist-tags": Record<string, string>;
	versions: Record<string, VersionDoc>;
	time: Record<string, string>;
}

interface Faults {
	dropReplyOnce: boolean;
	lostBeforeOnce: boolean;
	invisiblePublishOnce: boolean;
	statusOnce: number | undefined;
	appliedStatusOnce: number | undefined;
}

export interface WorldOptions {
	readonly base?: string;
	readonly bearer?: string;
	readonly idToken?: string;
	readonly packument?: Doc;
}

export function registryWorld(options: WorldOptions = {}) {
	const base = options.base ?? "https://registry.npmjs.org";
	const bearer = options.bearer ?? TOKEN;
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
	};

	function respond(
		status: number,
		body: Doc | Readonly<Record<string, string | boolean>>,
	): TransportResponse {
		return {
			status,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		};
	}

	function apply(request: TransportRequest, path: string): TransportResponse {
		const auth = request.headers.authorization;
		if (path.startsWith("/-/npm/v1/oidc/token/exchange/package/")) {
			if (request.method !== "POST" || auth !== `Bearer ${options.idToken}`)
				return respond(401, { error: "invalid id token" });
			return respond(201, { token: PUBLISH_TOKEN });
		}
		if (auth !== `Bearer ${bearer}`)
			return respond(401, { error: "unauthorized" });
		if (path === `/${NAME}` && request.method === "GET")
			return packument
				? respond(200, packument)
				: respond(404, { error: "Not found" });
		const tagPrefix = `/-/package/${NAME}/dist-tags/`;
		if (path.startsWith(tagPrefix) && request.method === "PUT") {
			if (!packument) return respond(404, { error: "Not found" });
			const version = JSON.parse(request.body ?? "null");
			if (!packument.versions?.[version])
				return respond(404, { error: "no such version" });
			packument["dist-tags"][path.slice(tagPrefix.length)] = version;
			return respond(201, { ok: true });
		}
		if (path === `/${NAME}` && request.method === "PUT") {
			const doc = JSON.parse(request.body ?? "{}");
			if (doc._attachments) {
				const [version] = Object.keys(doc.versions);
				if (packument?.versions?.[version] || packument?.time?.[version])
					return respond(403, {
						error: "You cannot publish over the previously published versions",
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
					_id: NAME,
					name: NAME,
					"dist-tags": {},
					versions: {},
					time: {},
				};
				packument.versions[version] = {
					...doc.versions[version],
					dist: {
						...doc.versions[version].dist,
						...(sigstore
							? {
									attestations: {
										url: `${base}/-/npm/v1/attestations/${NAME}@${version}`,
										provenance: {
											predicateType: "https://slsa.dev/provenance/v1",
										},
									},
								}
							: undefined),
					},
				};
				Object.assign(packument["dist-tags"], doc["dist-tags"]);
				packument.time[version] = "2026-11-12T00:00:00.000Z";
				packument._rev = `${++rev}-fixture`;
				return respond(200, { success: true });
			}
			if (!packument || doc._rev !== packument._rev)
				return respond(409, { error: "revision conflict" });
			packument = { ...doc, _rev: `${++rev}-fixture` };
			return respond(200, { ok: true });
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
		if (mutation && faults.lostBeforeOnce) {
			faults.lostBeforeOnce = false;
			throw new Error("socket hang up");
		}
		if (mutation && faults.statusOnce !== undefined) {
			const status = faults.statusOnce;
			faults.statusOnce = undefined;
			return respond(status, { error: "injected" });
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
): Doc {
	return {
		_id: NAME,
		_rev: "1-fixture",
		name: NAME,
		"dist-tags": tags,
		versions: {
			[version]: {
				name: NAME,
				version,
				dist: {
					integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
					shasum: createHash("sha1").update(bytes).digest("hex"),
					tarball: `https://registry.npmjs.org/${NAME}/-/widget-${version}.tgz`,
				},
			},
		},
		time: { [version]: "2026-11-12T00:00:00.000Z" },
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

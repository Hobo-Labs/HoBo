// OIDC fixtures shaped like the GitHub Actions and GitLab CI ID tokens, signed
// with throwaway RS256 keys, plus an HttpTransport that serves each issuer's
// discovery document and JWKS.
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { create, type JsonValue } from "@bufbuild/protobuf";
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	type TrustedPublisherRecord,
	TrustedPublisherRecordSchema,
} from "../../src/_generated/cd_pb.js";

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const GITLAB_ISSUER = "https://gitlab.com";
export const AUDIENCE = "https://cd.acme.example";

type Key = Readonly<{
	kid: string;
	privateKey: KeyObject;
	jwk: Record<string, string>;
}>;

export function rsaKey(kid: string): Key {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const jwk = publicKey.export({ format: "jwk" });
	return {
		kid,
		privateKey,
		jwk: {
			kty: String(jwk.kty),
			n: String(jwk.n),
			e: String(jwk.e),
			kid,
			alg: "RS256",
			use: "sig",
		},
	};
}

function b64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

/** JWT claims or header members, as JSON. */
export type Claims = { readonly [key: string]: JsonValue };

/** The same claims without one member (for "missing claim" cases). */
export function withoutClaim(claims: Claims, name: string): Claims {
	return Object.fromEntries(
		Object.entries(claims).filter(([key]) => key !== name),
	);
}

export function signJwt(key: Key, claims: Claims, header: Claims = {}): string {
	const head = b64url(
		JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid, ...header }),
	);
	const body = b64url(JSON.stringify(claims));
	const signature = createSign("RSA-SHA256")
		.update(`${head}.${body}`)
		.end()
		.sign(key.privateKey);
	return `${head}.${body}.${b64url(signature)}`;
}

export function githubClaims(nowMs: number, overrides: Claims = {}) {
	const now = Math.floor(nowMs / 1000);
	return {
		iss: GITHUB_ISSUER,
		aud: AUDIENCE,
		sub: "repo:acme/shop:environment:release",
		repository: "acme/shop",
		repository_owner: "acme",
		repository_id: "123456",
		workflow_ref: "acme/shop/.github/workflows/release.yml@refs/heads/main",
		ref: "refs/heads/main",
		environment: "release",
		event_name: "push",
		runner_environment: "github-hosted",
		jti: "0b6e1f3a-2c4d-4e5f-8a9b-0c1d2e3f4a5b",
		iat: now - 5,
		nbf: now - 5,
		exp: now + 300,
		...overrides,
	};
}

export function gitlabClaims(nowMs: number, overrides: Claims = {}) {
	const now = Math.floor(nowMs / 1000);
	return {
		iss: GITLAB_ISSUER,
		aud: AUDIENCE,
		sub: "project_path:acme/shop:ref_type:branch:ref:main",
		namespace_id: "42",
		namespace_path: "acme",
		project_id: "4242",
		project_path: "acme/shop",
		pipeline_source: "push",
		ref: "main",
		ref_type: "branch",
		ref_protected: "true",
		ci_config_ref_uri: "gitlab.com/acme/shop//.gitlab-ci.yml@refs/heads/main",
		jti: "7f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b",
		iat: now - 5,
		nbf: now - 5,
		exp: now + 300,
		...overrides,
	};
}

type Route = { status: number; body: string; headers: Record<string, string> };

/** Serves OIDC discovery + JWKS per issuer; counts every request by URL. */
export class OidcTransport {
	readonly calls: string[] = [];
	readonly routes = new Map<string, Route>();
	readonly keys = new Map<string, Key[]>();

	issuer(
		issuer: string,
		keys: Key[],
		jwksPath: string,
		cacheControl = "max-age=300",
	): void {
		const jwksUri = `${issuer}${jwksPath}`;
		this.keys.set(issuer, keys);
		this.routes.set(`${issuer}/.well-known/openid-configuration`, {
			status: 200,
			headers: {
				"content-type": "application/json",
				"cache-control": cacheControl,
			},
			body: JSON.stringify({
				issuer,
				jwks_uri: jwksUri,
				id_token_signing_alg_values_supported: ["RS256"],
			}),
		});
		this.setJwks(jwksUri, keys, cacheControl);
	}

	setJwks(jwksUri: string, keys: Key[], cacheControl = "max-age=300"): void {
		this.routes.set(jwksUri, {
			status: 200,
			headers: {
				"content-type": "application/json",
				"cache-control": cacheControl,
			},
			body: JSON.stringify({ keys: keys.map((key) => key.jwk) }),
		});
	}

	count(url: string): number {
		return this.calls.filter((call) => call === url).length;
	}

	readonly transport: HttpTransport = async (
		request: TransportRequest,
	): Promise<TransportResponse> => {
		this.calls.push(request.url);
		const route = this.routes.get(request.url);
		if (!route) return { status: 404, headers: {}, body: "not found" };
		return { status: route.status, headers: route.headers, body: route.body };
	};
}

export function githubPublisher(
	overrides: Partial<Omit<TrustedPublisherRecord, "$typeName">> = {},
): TrustedPublisherRecord {
	return create(TrustedPublisherRecordSchema, {
		name: "github-shop",
		issuer: GITHUB_ISSUER,
		audience: AUDIENCE,
		requiredClaims: {
			repository: "acme/shop",
			workflow_ref: "acme/shop/.github/workflows/release.yml@refs/heads/main",
			environment: "release",
		},
		bindles: ["shop"],
		...overrides,
	});
}

export function gitlabPublisher(): TrustedPublisherRecord {
	return create(TrustedPublisherRecordSchema, {
		name: "gitlab-shop",
		issuer: GITLAB_ISSUER,
		audience: AUDIENCE,
		requiredClaims: {
			project_path: "acme/shop",
			ref: "main",
			ref_protected: "true",
		},
		bindles: ["shop"],
	});
}

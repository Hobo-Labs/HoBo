/**
 * Local OIDC issuers for tests: Vercel (team mode), GitHub Actions and a
 * Cloudflare Access team, each with its own RSA key and the discovery and
 * key documents the Worker fetches. Nothing reaches the real issuers.
 */
import {
	createSign,
	generateKeyPairSync,
	type KeyObject,
	randomUUID,
} from "node:crypto";

export const VERCEL_TEAM = "hobo-team";
export const VERCEL_ISSUER = `https://oidc.vercel.com/${VERCEL_TEAM}`;
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const ACCESS_ISSUER = "https://hobo-owner.cloudflareaccess.com";
export const ACCESS_AUD = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

type Issuer = Readonly<{
	issuer: string;
	kid: string;
	privateKey: KeyObject;
	jwks: { keys: Record<string, string>[] };
	keysPath: string;
}>;

function issuer(url: string, keysPath: string): Issuer {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const kid = randomUUID();
	const jwk = publicKey.export({ format: "jwk" });
	return {
		issuer: url,
		kid,
		privateKey,
		keysPath,
		jwks: {
			keys: [
				{
					kty: "RSA",
					kid,
					alg: "RS256",
					use: "sig",
					n: String(jwk.n),
					e: String(jwk.e),
				},
			],
		},
	};
}

function b64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

export type Issuers = Readonly<{
	vercel: Issuer;
	github: Issuer;
	access: Issuer;
	/** Serves discovery and keys; counts requests per URL. */
	fetch: typeof fetch;
	requests: string[];
}>;

export function createIssuers(): Issuers {
	const vercel = issuer(VERCEL_ISSUER, "/.well-known/jwks");
	const github = issuer(GITHUB_ISSUER, "/.well-known/jwks");
	const access = issuer(ACCESS_ISSUER, "/cdn-cgi/access/certs");
	const all = [vercel, github, access];
	const requests: string[] = [];
	const send: typeof fetch = async (input) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		requests.push(url.toString());
		for (const candidate of all) {
			if (url.origin !== new URL(candidate.issuer).origin) continue;
			const base = new URL(candidate.issuer).pathname.replace(/\/$/u, "");
			if (url.pathname === `${base}/.well-known/openid-configuration`)
				return Response.json({
					issuer: candidate.issuer,
					jwks_uri: `${candidate.issuer}${candidate.keysPath}`,
				});
			if (url.pathname === `${base}${candidate.keysPath}`)
				return Response.json(candidate.jwks);
		}
		return new Response("not found", { status: 404 });
	};
	return { vercel, github, access, fetch: send, requests };
}

export type Claims = Readonly<
	Record<string, string | number | readonly string[]>
>;

/** An RS256 token from `from`, with `claims` over sensible defaults. */
export function sign(
	from: Issuer,
	claims: Claims,
	header: Readonly<Record<string, string>> = {},
	nowSeconds = Math.floor(Date.now() / 1000),
): string {
	const head = b64url(
		JSON.stringify({ alg: "RS256", typ: "JWT", kid: from.kid, ...header }),
	);
	const body = b64url(
		JSON.stringify({
			iss: from.issuer,
			iat: nowSeconds,
			nbf: nowSeconds,
			exp: nowSeconds + 3600,
			...claims,
		}),
	);
	const signer = createSign("RSA-SHA256");
	signer.update(`${head}.${body}`);
	return `${head}.${body}.${signer.sign(from.privateKey).toString("base64url")}`;
}

export const RELAY_CLAIMS = Object.freeze({
	aud: `https://vercel.com/${VERCEL_TEAM}`,
	sub: `owner:${VERCEL_TEAM}:project:hobo-ci:environment:production`,
	owner: VERCEL_TEAM,
	owner_id: "team_fixture",
	project: "hobo-ci",
	project_id: "prj_fixture",
	environment: "production",
});

export function deployClaims(storeId: string) {
	return {
		aud: `urn:hobo:config-service:${storeId}`,
		sub: "repo:Hobo-Labs/HoBo:ref:refs/heads/main",
		repository: "Hobo-Labs/HoBo",
		repository_id: "123456789",
		ref: "refs/heads/main",
	};
}

export const OWNER_CLAIMS = Object.freeze({
	aud: [ACCESS_AUD],
	sub: "owner-subject",
});

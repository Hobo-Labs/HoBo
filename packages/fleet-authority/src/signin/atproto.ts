/**
 * The `atproto` sign-in provider (§6.5): AT Protocol OAuth against one
 * configured authorization server (a PDS entryway). As that profile requires:
 * pushed authorization requests, PKCE (S256), and DPoP-bound token requests
 * that retry once with the server's `DPoP-Nonce`. The client id is the URL of
 * the authority's published client metadata. The principal is the `user`
 * named by the account's DID (`sub` of the token response); no token is kept.
 */
import {
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	sign,
} from "node:crypto";
import type { Clock, SignInProvider } from "@hobo/fleet";
import {
	failed,
	isRecord,
	isText,
	type JsonAnswer,
	requestJson,
} from "./http.js";

export type AtprotoProviderOptions = Readonly<{
	/** The authorization server's issuer, e.g. https://bsky.social. */
	authorizationServer: string;
	/** The URL of the client metadata document; it is also the client id. */
	clientId: string;
	fetch: typeof fetch;
	now: Clock;
}>;

type Metadata = Readonly<{
	issuer: string;
	par: string;
	authorize: string;
	token: string;
}>;

/** A DPoP proof (RFC 9449) with an optional server nonce, ES256 over a key held for this provider. */
function proof(
	key: KeyObject,
	jwk: Readonly<Record<string, string>>,
	htm: string,
	htu: string,
	nowMs: number,
	nonce: string,
): string {
	const header = { typ: "dpop+jwt", alg: "ES256", jwk };
	const base = {
		jti: randomBytes(16).toString("base64url"),
		htm,
		htu,
		iat: Math.floor(nowMs / 1000),
	};
	const claims = nonce.length > 0 ? { ...base, nonce } : base;
	const head = Buffer.from(JSON.stringify(header)).toString("base64url");
	const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = sign("sha256", Buffer.from(`${head}.${body}`), {
		key,
		dsaEncoding: "ieee-p1363",
	});
	return `${head}.${body}.${signature.toString("base64url")}`;
}

export function createAtprotoSignInProvider(
	options: AtprotoProviderOptions,
): SignInProvider {
	const server = options.authorizationServer.replace(/\/+$/u, "");
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "P-256",
	});
	const exported = publicKey.export({ format: "jwk" });
	const jwk = {
		kty: "EC",
		crv: "P-256",
		x: exported.x ?? "",
		y: exported.y ?? "",
	};
	let metadata: Metadata | undefined;
	let nonce = "";

	const discover = async (): Promise<Metadata> => {
		if (metadata !== undefined) return metadata;
		const answer = await requestJson(
			options.fetch,
			`${server}/.well-known/oauth-authorization-server`,
		);
		const document = answer.body;
		if (
			!isRecord(document) ||
			document.issuer !== server ||
			!isText(document.pushed_authorization_request_endpoint) ||
			!isText(document.authorization_endpoint) ||
			!isText(document.token_endpoint)
		)
			throw new Error("the authorization server's metadata is not usable");
		metadata = {
			issuer: server,
			par: document.pushed_authorization_request_endpoint,
			authorize: document.authorization_endpoint,
			token: document.token_endpoint,
		};
		return metadata;
	};

	/** A DPoP-bound POST that retries once with the server's nonce. */
	const post = async (
		url: string,
		form: Readonly<Record<string, string>>,
	): Promise<JsonAnswer> => {
		let answer: JsonAnswer | undefined;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			answer = await requestJson(options.fetch, url, {
				form,
				headers: {
					dpop: proof(privateKey, jwk, "POST", url, options.now(), nonce),
				},
			});
			nonce = answer.headers.get("dpop-nonce") ?? nonce;
			const error = isRecord(answer.body) ? answer.body.error : undefined;
			if (error !== "use_dpop_nonce") break;
		}
		if (answer === undefined) throw new Error("no answer");
		return answer;
	};

	return {
		id: "atproto",
		async begin(input) {
			const server = await discover();
			const pushed = await post(server.par, {
				client_id: options.clientId,
				response_type: "code",
				redirect_uri: input.redirectUri,
				scope: "atproto",
				state: input.state,
				code_challenge: input.codeChallenge,
				code_challenge_method: "S256",
			});
			const requestUri = isRecord(pushed.body)
				? pushed.body.request_uri
				: undefined;
			if (pushed.status >= 300 || !isText(requestUri))
				throw new Error("the authorization server refused the pushed request");
			const url = new URL(server.authorize);
			url.searchParams.set("client_id", options.clientId);
			url.searchParams.set("request_uri", requestUri);
			return { url: url.toString() };
		},
		async complete(input) {
			const server = await discover();
			const answer = await post(server.token, {
				grant_type: "authorization_code",
				code: input.code,
				redirect_uri: input.redirectUri,
				client_id: options.clientId,
				code_verifier: input.codeVerifier,
			});
			const sub = isRecord(answer.body) ? answer.body.sub : undefined;
			if (answer.status !== 200 || !isText(sub) || !sub.startsWith("did:"))
				return failed(
					"unauthenticated",
					"the authorization server refused the code",
				);
			return {
				ok: true,
				value: {
					principal: { kind: "user", id: sub },
					claims: { iss: server.issuer, sub, did: sub },
				},
			};
		},
	};
}

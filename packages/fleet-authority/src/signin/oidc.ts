/**
 * The `oidc` sign-in provider (§6.5): an organisation's OpenID Connect
 * identity provider, authorization code flow with PKCE (S256). The nonce is
 * derived from the sign-in state, so `complete` can check it without storing
 * anything; the ID token is verified against the issuer's own keys through
 * `createIdentityAssertionVerifier`, pinned to this one issuer, with the
 * client id as audience. The principal is a `user` named by the configured
 * claim (`sub` by default), prefixed with the issuer's host so two issuers
 * never name the same person.
 */
import { createHash } from "node:crypto";
import type { Clock, SignInProvider } from "@hobo/fleet";
import { createIdentityAssertionVerifier } from "../identity/assertions.js";
import { failed, isRecord, isText, requestJson } from "./http.js";

export type OidcProviderOptions = Readonly<{
	issuer: string;
	clientId: string;
	/** Absent for a public client; otherwise read from the secret store when needed. */
	clientSecret?: (() => Promise<string>) | undefined;
	scopes?: readonly string[] | undefined;
	/** The ID token claim naming the person; default `sub`. */
	principalClaim?: string | undefined;
	fetch: typeof fetch;
	now: Clock;
}>;

export function nonceOf(state: string): string {
	return createHash("sha256")
		.update("hobo-fleet/oidc-nonce/v1\u0000")
		.update(state)
		.digest("base64url");
}

export function createOidcSignInProvider(
	options: OidcProviderOptions,
): SignInProvider {
	const issuer = options.issuer.replace(/\/+$/u, "");
	const host = new URL(issuer).host;
	const verifier = createIdentityAssertionVerifier({
		issuers: [{ issuer }],
		fetch: options.fetch,
		now: options.now,
	});
	let endpoints: Readonly<{ authorize: string; token: string }> | undefined;

	const discover = async () => {
		if (endpoints !== undefined) return endpoints;
		const answer = await requestJson(
			options.fetch,
			`${issuer}/.well-known/openid-configuration`,
		);
		const document = answer.body;
		if (
			!isRecord(document) ||
			document.issuer !== issuer ||
			!isText(document.authorization_endpoint) ||
			!isText(document.token_endpoint)
		)
			throw new Error("the issuer's discovery document is not usable");
		endpoints = {
			authorize: document.authorization_endpoint,
			token: document.token_endpoint,
		};
		return endpoints;
	};

	return {
		id: "oidc",
		async begin(input) {
			const { authorize } = await discover();
			const url = new URL(authorize);
			url.searchParams.set("response_type", "code");
			url.searchParams.set("client_id", options.clientId);
			url.searchParams.set("redirect_uri", input.redirectUri);
			url.searchParams.set(
				"scope",
				["openid", ...(options.scopes ?? ["email", "profile"])].join(" "),
			);
			url.searchParams.set("state", input.state);
			url.searchParams.set("nonce", nonceOf(input.state));
			url.searchParams.set("code_challenge", input.codeChallenge);
			url.searchParams.set("code_challenge_method", "S256");
			return { url: url.toString() };
		},
		async complete(input) {
			const { token } = await discover();
			const form = new URLSearchParams({
				grant_type: "authorization_code",
				code: input.code,
				redirect_uri: input.redirectUri,
				client_id: options.clientId,
				code_verifier: input.codeVerifier,
			});
			if (options.clientSecret !== undefined)
				form.set("client_secret", await options.clientSecret());
			const answer = await requestJson(options.fetch, token, {
				form: Object.fromEntries(form),
			});
			if (answer.status !== 200 || !isRecord(answer.body))
				return failed(
					"unauthenticated",
					"the identity provider refused the code",
				);
			const idToken = answer.body.id_token;
			if (!isText(idToken))
				return failed(
					"unauthenticated",
					"the identity provider sent no ID token",
				);
			const verified = await verifier.verifyOidc(idToken, options.clientId);
			if (!verified.ok) return verified;
			if (verified.value.claims.nonce !== nonceOf(input.state))
				return failed(
					"unauthenticated",
					"the ID token answers another sign-in",
				);
			const name = verified.value.claims[options.principalClaim ?? "sub"] ?? "";
			if (name.length === 0)
				return failed(
					"unauthenticated",
					"the ID token does not name the person",
				);
			return {
				ok: true,
				value: {
					principal: { kind: "user", id: `${host}/${name}` },
					claims: verified.value.claims,
				},
			};
		},
	};
}

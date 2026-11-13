/**
 * How the adapter signs in to Infisical. The relay and CI use OIDC Auth with
 * a workload token they already hold, so neither keeps a secret to get its
 * secrets ("no secret zero"):
 *
 * - the relay: its Vercel OIDC token (`getVercelOidcToken()` of `@vercel/oidc`,
 *   wired by `@hobo/ci-vercel`; this package does not depend on Vercel);
 * - CI: the GitHub Actions OIDC token, `githubActionsJwtSource` below;
 * - tests: any function that returns a JWT.
 *
 * An owner's own machine may instead use Universal Auth (a machine identity's
 * client id and secret, supplied through the environment at run time) or an
 * access token the Infisical CLI already issued.
 *
 * OIDC Auth login: https://infisical.com/docs/api-reference/endpoints/oidc-auth/login
 * Universal Auth login: https://infisical.com/docs/api-reference/endpoints/universal-auth/login
 */

import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { GithubActionsIdTokenSchema } from "./_generated/adapter_infisical_pb.js";
import {
	type InfisicalIdentityId,
	parseInfisicalIdentityId,
} from "./binding.js";
import { InfisicalError } from "./errors.js";

/** Returns a fresh workload JWT. Called once per login; never cached here. */
export type JwtSource = () => Promise<string>;

export type InfisicalAuth =
	| Readonly<{
			method: "oidc";
			identityId: InfisicalIdentityId;
			jwt: JwtSource;
	  }>
	| Readonly<{
			method: "universal-auth";
			clientId: string;
			clientSecret: string;
	  }>
	| Readonly<{ method: "access-token"; accessToken: string }>;

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const OPAQUE = /^[!-~]{1,16384}$/u;

/** A JWT, refused (without echoing it) when it does not look like one. */
export function parseJwt(value: string): string {
	if (value.length > 16_384 || !JWT.test(value))
		throw new InfisicalError("workload identity token", "jwt-unavailable");
	return value;
}

/** OIDC claim hints for operators (sub/aud only). Never includes the JWT. */
export type JwtOidcClaimHints = Readonly<{ sub?: string; aud?: string }>;

type JwtOidcClaimHintsBuilder = { sub?: string; aud?: string };

/**
 * OIDC claim hints for operators (sub/aud only). Never returns the JWT itself.
 */
const jwtPayloadTag = Object.prototype.toString;

function jwtPayloadObject(
	value: JsonValue,
): Readonly<Record<string, JsonValue>> | undefined {
	// SAFETY: the tag check proves a plain object from JSON.parse of a JWT payload segment.
	return jwtPayloadTag.call(value) === "[object Object]"
		? (value as Record<string, JsonValue>)
		: undefined;
}

function jwtPayloadString(value: JsonValue | undefined): string | undefined {
	// SAFETY: the tag check proves a string primitive in the JWT payload.
	return jwtPayloadTag.call(value) === "[object String]"
		? (value as string)
		: undefined;
}

export function jwtOidcClaimHints(jwt: string): JwtOidcClaimHints {
	const segment = jwt.split(".")[1];
	if (segment === undefined) return Object.freeze({});
	try {
		const payload: JsonValue = JSON.parse(
			Buffer.from(segment, "base64url").toString("utf8"),
		);
		const record = jwtPayloadObject(payload);
		if (record === undefined) return Object.freeze({});
		const hints: JwtOidcClaimHintsBuilder = {};
		const sub = jwtPayloadString(record.sub);
		if (sub !== undefined && sub !== "") hints.sub = sub;
		const aud = record.aud;
		const audText = jwtPayloadString(aud);
		if (audText !== undefined && audText !== "") {
			hints.aud = audText;
		} else if (Array.isArray(aud)) {
			const joined = aud
				.map((entry) => jwtPayloadString(entry))
				.filter((entry): entry is string => entry !== undefined)
				.join(",");
			if (joined !== "") hints.aud = joined;
		}
		return Object.freeze(hints);
	} catch {
		return Object.freeze({});
	}
}

export function oidcAuth(input: {
	readonly identityId: string | undefined;
	readonly jwt: JwtSource;
}): InfisicalAuth {
	return Object.freeze({
		method: "oidc",
		identityId: parseInfisicalIdentityId(input.identityId),
		jwt: input.jwt,
	});
}

/**
 * The owner's credentials on their own machine, read from the environment
 * when the command runs, never from a file HoBo writes:
 * `INFISICAL_TOKEN` (an access token, e.g. from
 * `infisical login --method=universal-auth --silent --plain`), or
 * `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` + `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`
 * (the names the Infisical CLI itself reads). Undefined when neither is set.
 */
export function ownerAuthFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): InfisicalAuth | undefined {
	const token = env.INFISICAL_TOKEN;
	if (token) {
		if (!OPAQUE.test(token))
			throw new InfisicalError("owner credentials", "invalid-input");
		return Object.freeze({ method: "access-token", accessToken: token });
	}
	const clientId = env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID;
	const clientSecret = env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET;
	if (!clientId && !clientSecret) return undefined;
	if (
		!clientId ||
		!clientSecret ||
		!OPAQUE.test(clientId) ||
		!OPAQUE.test(clientSecret)
	)
		throw new InfisicalError("owner credentials", "invalid-input");
	return Object.freeze({ method: "universal-auth", clientId, clientSecret });
}

/**
 * The GitHub Actions OIDC token of the running job (the job needs
 * `permissions: id-token: write`). GitHub documents the request:
 * GET `$ACTIONS_ID_TOKEN_REQUEST_URL&audience=<aud>` with
 * `Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN`, answering
 * `{ "value": "<jwt>" }`
 * (https://docs.github.com/en/actions/reference/security/oidc).
 * Without an audience GitHub uses its default, `https://github.com/<owner>`.
 */
export function githubActionsJwtSource(
	options: {
		readonly env?: Readonly<Record<string, string | undefined>>;
		readonly audience?: string;
		readonly fetch?: typeof fetch;
	} = {},
): JwtSource {
	return async () => {
		const env = options.env ?? process.env;
		const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
		const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
		if (!requestUrl || !requestToken)
			throw new InfisicalError("GitHub Actions OIDC token", "jwt-unavailable");
		let url: URL;
		try {
			url = new URL(requestUrl);
		} catch {
			throw new InfisicalError("GitHub Actions OIDC token", "jwt-unavailable");
		}
		if (url.protocol !== "https:" && url.hostname !== "127.0.0.1")
			throw new InfisicalError("GitHub Actions OIDC token", "jwt-unavailable");
		if (options.audience !== undefined)
			url.searchParams.set("audience", options.audience);
		let response: Response;
		try {
			response = await (options.fetch ?? fetch)(url.href, {
				headers: {
					authorization: `bearer ${requestToken}`,
					accept: "application/json",
				},
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			throw new InfisicalError("GitHub Actions OIDC token", "jwt-unavailable", {
				retryable: true,
			});
		}
		if (!response.ok)
			throw new InfisicalError("GitHub Actions OIDC token", "jwt-unavailable", {
				status: response.status,
			});
		let value: string;
		try {
			const body: JsonValue = await response.json();
			value = fromJson(GithubActionsIdTokenSchema, body, {
				ignoreUnknownFields: true,
			}).value;
		} catch {
			throw new InfisicalError("GitHub Actions OIDC token", "jwt-unavailable");
		}
		return parseJwt(value);
	};
}

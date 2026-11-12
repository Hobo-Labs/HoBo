/**
 * A GitHub Actions OIDC token from any workflow of a repository, for routes
 * that answer that repository's own workflows (the fleet reporter status
 * route, ADR-0180). Unlike the runner-claim verifier in `oidc.ts`, which
 * accepts only `workflow_dispatch` and serves the bridge, this one accepts
 * any event: a scheduled monitor asks too. It proves which repository is
 * asking and nothing more; the route decides what that repository may see.
 *
 * Key discovery stays pinned to GitHub; no key URL a token names is fetched.
 */
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

// public-contract: GitHub Actions' OIDC issuer and its key set.
const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS = `${ISSUER}/.well-known/jwks`;

const Header = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) });
const Claims = z.object({
	iss: z.literal(ISSUER),
	aud: z.union([z.string(), z.array(z.string())]),
	exp: z.number().int(),
	nbf: z.number().int(),
	iat: z.number().int(),
	repository: z.string().regex(/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/),
	repository_id: z.string().regex(/^\d+$/),
	event_name: z.string().min(1),
	run_id: z.string().regex(/^\d+$/),
});
const Keys = z.object({
	keys: z.array(
		z.object({
			kid: z.string(),
			kty: z.literal("RSA"),
			n: z.string(),
			e: z.string(),
			alg: z.literal("RS256").optional(),
			use: z.literal("sig").optional(),
		}),
	),
});

/** What a verified workflow token says about who is asking. */
export type GithubWorkflowClaims = Readonly<{
	/** `owner/name` as GitHub spells it. */
	repository: string;
	repositoryId: string;
	eventName: string;
	runId: string;
}>;

export type GithubWorkflowVerifier = Readonly<{
	/** The token's claims, or a throw when it is not a live token for this audience. */
	verify(token: string): Promise<GithubWorkflowClaims>;
}>;

export function createGithubWorkflowVerifier(options: {
	/** This relay's public origin: the audience a workflow asks GitHub for. */
	audience: string;
	fetch?: typeof fetch;
	now?: () => number;
}): GithubWorkflowVerifier {
	const send = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	return {
		async verify(token) {
			if (token.length > 16000) throw new Error("invalid identity");
			const parts = token.split(".");
			const [headerText, bodyText, signature] = parts;
			if (parts.length !== 3 || !headerText || !bodyText || !signature)
				throw new Error("invalid identity");
			const header = Header.parse(
				JSON.parse(Buffer.from(headerText, "base64url").toString()),
			);
			const response = await send(JWKS, {
				redirect: "error",
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) throw new Error("identity keys unavailable");
			const key = Keys.parse(await response.json()).keys.find(
				(candidate) => candidate.kid === header.kid,
			);
			if (
				!key ||
				!verify(
					"RSA-SHA256",
					Buffer.from(`${headerText}.${bodyText}`),
					createPublicKey({ key, format: "jwk" }),
					Buffer.from(signature, "base64url"),
				)
			)
				throw new Error("invalid identity signature");
			const claims = Claims.parse(
				JSON.parse(Buffer.from(bodyText, "base64url").toString()),
			);
			const audiences = [claims.aud].flat();
			const seconds = Math.floor(now() / 1000);
			if (
				audiences.length !== 1 ||
				audiences[0] !== options.audience ||
				claims.exp <= seconds ||
				claims.nbf > seconds + 30 ||
				claims.iat > seconds + 30 ||
				seconds - claims.iat > 600
			)
				throw new Error("identity audience or lifetime invalid");
			return {
				repository: claims.repository,
				repositoryId: claims.repository_id,
				eventName: claims.event_name,
				runId: claims.run_id,
			};
		},
	};
}

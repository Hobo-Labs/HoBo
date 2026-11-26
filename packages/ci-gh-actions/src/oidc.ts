import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

const Header = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) });
const Claims = z.object({
	iss: z.literal("https://token.actions.githubusercontent.com"),
	aud: z.string(),
	exp: z.number().int(),
	nbf: z.number().int(),
	iat: z.number().int(),
	repository_id: z.string().regex(/^\d+$/),
	repository: z.string(),
	run_id: z.string().regex(/^\d+$/),
	run_attempt: z.string().regex(/^\d+$/),
	workflow_sha: z.string().regex(/^[a-f0-9]{40}$/),
	workflow_ref: z.string(),
	event_name: z.literal("workflow_dispatch"),
});
export type GithubClaims = z.infer<typeof Claims>;
export interface IdentityVerifier {
	verify(token: string): Promise<GithubClaims>;
}

/** Key discovery stays pinned to GitHub; no JWT-supplied key URL is fetched. */
export function createGithubOidcVerifier(
	audience: string,
	send: typeof fetch = fetch,
	now: () => number = Date.now,
): IdentityVerifier {
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
			const response = await send(
				"https://token.actions.githubusercontent.com/.well-known/jwks",
				{ redirect: "error", signal: AbortSignal.timeout(10000) },
			);
			if (!response.ok) throw new Error("identity keys unavailable");
			const keys = z
				.object({
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
				})
				.parse(await response.json());
			const key = keys.keys.find((candidate) => candidate.kid === header.kid);
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
			const seconds = Math.floor(now() / 1000);
			if (
				claims.aud !== audience ||
				claims.exp <= seconds ||
				claims.nbf > seconds + 30 ||
				claims.iat > seconds + 30 ||
				seconds - claims.iat > 600
			)
				throw new Error("identity audience or lifetime invalid");
			return claims;
		},
	};
}

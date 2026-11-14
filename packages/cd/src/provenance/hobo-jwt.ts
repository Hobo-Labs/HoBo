// HoBo-signed attestations: a compact JWT minted by the identity issuer
// (`JwtSvidIssuer.signJwtSvid`) whose `codeVersion.digest` claim binds the
// sha256 of the exact statement bytes — the same binding convention
// `@hobo/registry` uses for bundle manifests. Verified with the registry
// `SignatureVerifier` key material through `@hobo/identity`.
import { verifyJwtWithJwks } from "@hobo/identity";
import type { SignatureVerifier } from "@hobo/registry";
import { isJsonObject, isJsonString } from "../artifacts/json.js";

export type JwtResult =
	| Readonly<{ ok: true; signer: string; issuer: string }>
	| Readonly<{ ok: false; stage: "signature" | "payload"; detail: string }>;

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function isCompactJwt(text: string): boolean {
	return COMPACT_JWS.test(text);
}

export async function verifyHoboJwt(
	token: string,
	statementDigest: string,
	verifier: SignatureVerifier,
): Promise<JwtResult> {
	let claims: Awaited<ReturnType<typeof verifyJwtWithJwks>>["claims"];
	try {
		const verified = await verifyJwtWithJwks(
			token,
			{ keys: [...verifier.jwks.keys] },
			{
				issuer: verifier.issuer,
				audience: verifier.audience,
				now: verifier.now,
			},
		);
		claims = verified.claims;
	} catch (error) {
		// identity's messages name the failed check (signature, issuer, expiry), never the token.
		return {
			ok: false,
			stage: "signature",
			detail: error instanceof Error ? error.message : "invalid",
		};
	}
	const codeVersion = claims.codeVersion;
	const bound = isJsonObject(codeVersion) ? codeVersion.digest : undefined;
	if (bound !== statementDigest)
		return {
			ok: false,
			stage: "payload",
			detail: "codeVersion.digest does not bind the statement",
		};
	return {
		ok: true,
		signer: isJsonString(claims.sub) ? claims.sub : "",
		issuer: isJsonString(claims.iss) ? claims.iss : "",
	};
}

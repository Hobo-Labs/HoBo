import {
	createPublicKey,
	generateKeyPairSync,
	sign,
	verify as verifySignature,
} from "node:crypto";
import type {
	ElevatedCapabilityIssuer,
	ElevatedCapabilityVerifier,
	ElevatedSvidClaims,
} from "../../src/index.js";
import type { JsonObject } from "../../src/json.js";

export type TestElevatedIssuer = ElevatedCapabilityIssuer &
	Readonly<{ verify: ElevatedCapabilityVerifier }>;

const encode = (value: ElevatedSvidClaims | Readonly<Record<string, string>>) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");

export function createTestElevatedIssuer(
	issuerUrl = "https://identity.test",
): TestElevatedIssuer {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const jwk = publicKey.export({ format: "jwk" });
	return {
		issuerUrl,
		async signJwtSvid(claims: ElevatedSvidClaims) {
			const input = `${encode({ alg: "EdDSA", kid: "test#1", typ: "JWT" })}.${encode({ ...claims, iss: issuerUrl })}`;
			return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
		},
		async verify(token, options) {
			const [header, body, signature] = token.split(".");
			if (header === undefined || body === undefined || signature === undefined)
				throw new Error("JWT must have three segments");
			const key = createPublicKey({ key: jwk, format: "jwk" });
			if (
				!verifySignature(
					null,
					Buffer.from(`${header}.${body}`),
					key,
					Buffer.from(signature, "base64url"),
				)
			)
				throw new Error("JWT signature verification failed");
			const claims: JsonObject = JSON.parse(
				Buffer.from(body, "base64url").toString("utf8"),
			);
			if (claims.iss !== options.issuer) throw new Error("issuer mismatch");
			const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
			if (!audiences.includes(options.audience))
				throw new Error("audience mismatch");
			if (Number(claims.exp) <= options.now) throw new Error("JWT is expired");
			if (Number(claims.nbf) > options.now)
				throw new Error("JWT is not yet valid");
			return { claims };
		},
	};
}

import {
	createPublicKey,
	createSign,
	createVerify,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "./json.js";

export const JWT_ALGORITHM = "RS256";

export type KmsLike = Readonly<{
	hasKey(kid: string): boolean;
	generateRsaKey(kid: string): void;
	sign(kid: string, payload: string): Buffer;
	publicJwk(kid: string): JsonObject;
}>;

export function createInMemoryKms(): KmsLike {
	const keys = new Map<
		string,
		{ privateKey: KeyObject; publicKey: KeyObject }
	>();

	return {
		hasKey(kid: string) {
			return keys.has(kid);
		},
		generateRsaKey(kid: string) {
			if (keys.has(kid)) {
				throw new Error(`KMS key already exists: ${kid}`);
			}
			const { privateKey, publicKey } = generateKeyPairSync("rsa", {
				modulusLength: 2048,
			});
			keys.set(kid, { privateKey, publicKey });
		},
		sign(kid: string, payload: string) {
			const key = keys.get(kid);
			if (!key) {
				throw new Error(`unknown KMS key: ${kid}`);
			}
			return createSign("RSA-SHA256")
				.update(payload)
				.end()
				.sign(key.privateKey);
		},
		publicJwk(kid: string) {
			const key = keys.get(kid);
			if (!key) {
				throw new Error(`unknown KMS key: ${kid}`);
			}
			return {
				...key.publicKey.export({ format: "jwk" }),
				kid,
				alg: JWT_ALGORITHM,
				use: "sig",
			};
		},
	};
}

export interface JsonWebKeySet {
	readonly keys: JsonObject[];
}

export type OidcDiscovery = Readonly<{
	issuer: string;
	jwks_uri: string;
	id_token_signing_alg_values_supported: readonly string[];
	response_types_supported: readonly string[];
	subject_types_supported: readonly string[];
}>;

export type JwtSvidClaims = Readonly<{
	sub: string;
	aud: string | readonly string[];
	tenant: string;
	parentPrincipal: Readonly<{ kind: string; id: string }>;
	codeVersion: Readonly<{ digest: string; version: string }>;
	scope: readonly Readonly<{
		port: string;
		resource: string;
		verbs: readonly string[];
	}>[];
	exp: number;
	nbf: number;
	iat: number;
	iss?: string;
}>;

export class JwtSvidIssuer {
	readonly issuerUrl: string;
	readonly kms: KmsLike;
	readonly activeKeyId: string;
	readonly jwksKeyIds: readonly string[];

	constructor(options: {
		issuerUrl: string;
		kms: KmsLike;
		activeKeyId: string;
		jwksKeyIds: readonly string[];
	}) {
		this.issuerUrl = options.issuerUrl;
		this.kms = options.kms;
		this.activeKeyId = options.activeKeyId;
		this.jwksKeyIds = options.jwksKeyIds;
	}

	discovery(): OidcDiscovery {
		return {
			issuer: this.issuerUrl,
			jwks_uri: `${this.issuerUrl}/.well-known/jwks.json`,
			id_token_signing_alg_values_supported: [JWT_ALGORITHM],
			response_types_supported: ["id_token"],
			subject_types_supported: ["public"],
		};
	}

	jwks(): JsonWebKeySet {
		return { keys: this.jwksKeyIds.map((kid) => this.kms.publicJwk(kid)) };
	}

	async signJwtSvid(claims: JwtSvidClaims): Promise<string> {
		const header = { alg: JWT_ALGORITHM, kid: this.activeKeyId, typ: "JWT" };
		const payload = { ...claims, iss: this.issuerUrl };
		const signingInput = `${toBase64UrlJson(header)}.${toBase64UrlJson(payload)}`;
		const signature = this.kms.sign(this.activeKeyId, signingInput);
		return `${signingInput}.${toBase64Url(signature)}`;
	}

	rotateSigningKey(nextKeyId: string): JwtSvidIssuer {
		this.kms.generateRsaKey(nextKeyId);
		return new JwtSvidIssuer({
			issuerUrl: this.issuerUrl,
			kms: this.kms,
			activeKeyId: nextKeyId,
			jwksKeyIds: [...new Set([...this.jwksKeyIds, nextKeyId])],
		});
	}
}

export async function verifyJwtWithJwks(
	token: string,
	jwks: Readonly<{ keys: JsonObject[] }>,
	options: { issuer: string; audience: string; now: number },
): Promise<{
	header: JsonObject;
	claims: JsonObject;
}> {
	const segments = token.split(".");
	const [encodedHeader, encodedClaims, encodedSignature] = segments;
	if (
		segments.length !== 3 ||
		!encodedHeader ||
		!encodedClaims ||
		!encodedSignature
	) {
		throw new Error("JWT must have three segments");
	}
	if (!Number.isFinite(options.now)) {
		throw new Error("JWT verification clock is invalid");
	}
	const header = parseJwtObject(encodedHeader);
	const claims = parseJwtObject(encodedClaims);
	const kid = header.kid;
	if (!isJsonString(kid)) {
		throw new Error("JWT header missing kid");
	}
	const key = jwks.keys.find((candidate) => candidate.kid === kid);
	if (!key) {
		throw new Error("JWKS does not contain the signing key");
	}
	if (header.alg !== JWT_ALGORITHM) {
		throw new Error("unsupported JWT algorithm");
	}

	const verifier = createVerify("RSA-SHA256")
		.update(`${encodedHeader}.${encodedClaims}`)
		.end();
	const valid = verifier.verify(
		createPublicKey({ key, format: "jwk" }),
		fromBase64Url(encodedSignature),
	);
	if (!valid) {
		throw new Error("JWT signature verification failed");
	}
	if (claims.iss !== options.issuer) {
		throw new Error("issuer mismatch");
	}
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(options.audience)) {
		throw new Error("audience mismatch");
	}
	const exp = claims.exp;
	const nbf = claims.nbf;
	if (!isJsonNumber(exp) || !Number.isFinite(exp) || exp <= options.now) {
		throw new Error("JWT is expired");
	}
	if (!isJsonNumber(nbf) || !Number.isFinite(nbf) || nbf > options.now) {
		throw new Error("JWT is not yet valid");
	}

	return { header, claims };
}

function toBase64UrlJson<T>(value: T): string {
	return toBase64Url(Buffer.from(JSON.stringify(value)));
}

function toBase64Url(value: Buffer): string {
	return Buffer.from(value).toString("base64url");
}

function parseJwtObject(value: string): JsonObject {
	const text = fromBase64Url(value).toString("utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("JWT contains invalid JSON");
	}
	if (!isJsonObject(parsed)) {
		throw new Error("JWT header and claims must be objects");
	}
	return parsed;
}

function fromBase64Url(value: string): Buffer {
	if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
		throw new Error("JWT contains invalid base64url");
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.toString("base64url") !== value) {
		throw new Error("JWT contains invalid base64url");
	}
	return decoded;
}

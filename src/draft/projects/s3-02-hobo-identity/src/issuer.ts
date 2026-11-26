import {
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { asJsonObject, cloneAsJson, isJsonString, isJsonNumber, type JsonValue, type JsonObject } from "./json.js";


export const JWT_ALGORITHM = "RS256";

export interface JwksDocument {
  readonly keys: JsonObject[];
}

export type KmsLike = Readonly<{
  hasKey(kid: string): boolean;
  generateRsaKey(kid: string): void;
  sign(kid: string, payload: string): Buffer;
  publicJwk(kid: string): JsonObject;
}>;

export function createInMemoryKms(): KmsLike {
  const keys = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>();

  return {
    hasKey(kid: string) {
      return keys.has(kid);
    },
    generateRsaKey(kid: string) {
      if (keys.has(kid)) {
        throw new Error(`KMS key already exists: ${kid}`);
      }
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      keys.set(kid, { privateKey, publicKey });
    },
    sign(kid: string, payload: string) {
      const key = keys.get(kid);
      if (!key) {
        throw new Error(`unknown KMS key: ${kid}`);
      }
      return createSign("RSA-SHA256").update(payload).end().sign(key.privateKey);
    },
    publicJwk(kid: string) {
      const key = keys.get(kid);
      if (!key) {
        throw new Error(`unknown KMS key: ${kid}`);
      }
      return asJsonObject({ ...key.publicKey.export({ format: "jwk" }), kid, alg: JWT_ALGORITHM, use: "sig" });
    },
  };
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
  scope: readonly Readonly<{ port: string; resource: string; verbs: readonly string[] }>[];
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

  jwks(): JwksDocument {
    return { keys: this.jwksKeyIds.map((kid) => this.kms.publicJwk(kid)) };
  }

  async signJwtSvid(claims: JwtSvidClaims): Promise<string> {
    const header = { alg: JWT_ALGORITHM, kid: this.activeKeyId, typ: "JWT" };
    const payload = { ...claims, iss: this.issuerUrl };
    const signingInput = `${toBase64UrlJson(cloneAsJson(header))}.${toBase64UrlJson(cloneAsJson(payload))}`;
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
): Promise<{ header: JsonObject; claims: JsonObject }> {
  const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedClaims || !encodedSignature) {
    throw new Error("JWT must have three segments");
  }

  // SAFETY: `const header = JSON.parse(fromBase64Url(encodedHeader).toString("utf8")) as Json` is required at this I/O or test boundary.
  const header = JSON.parse(fromBase64Url(encodedHeader).toString("utf8")) as JsonObject;
  // SAFETY: `const claims = JSON.parse(fromBase64Url(encodedClaims).toString("utf8")) as Json` is required at this I/O or test boundary.
  const claims = JSON.parse(fromBase64Url(encodedClaims).toString("utf8")) as JsonObject;
  const kid = header.kid;
  if (!isJsonString(kid)) {
    throw new Error("JWT header missing kid");
  }
  const key = jwks.keys.find((candidate) => candidate.kid === kid);
  if (!key) {
    throw new Error(`JWKS does not contain kid ${kid}`);
  }
  if (header.alg !== JWT_ALGORITHM) {
    throw new Error(`unsupported alg ${String(header.alg)}`);
  }

  const verifier = createVerify("RSA-SHA256").update(`${encodedHeader}.${encodedClaims}`).end();
  const valid = verifier.verify(createPublicKey({ key, format: "jwk" }), fromBase64Url(encodedSignature));
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
  if (!isJsonNumber(exp) || exp <= options.now) {
    throw new Error("JWT is expired");
  }
  if (!isJsonNumber(nbf) || nbf > options.now) {
    throw new Error("JWT is not yet valid");
  }

  return { header, claims };
}

function toBase64UrlJson(value: JsonValue): string {
  return toBase64Url(Buffer.from(JSON.stringify(value)));
}

function toBase64Url(value: Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

import { createPublicKey, createSign, createVerify, generateKeyPairSync } from "node:crypto";

const ALGORITHM = "RS256";

export function createInMemoryKms() {
  const keys = new Map();

  return {
    hasKey(kid) {
      return keys.has(kid);
    },
    generateRsaKey(kid) {
      if (keys.has(kid)) {
        throw new Error(`KMS key already exists: ${kid}`);
      }
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      keys.set(kid, { privateKey, publicKey });
    },
    sign(kid, payload) {
      const key = keys.get(kid);
      if (!key) {
        throw new Error(`unknown KMS key: ${kid}`);
      }
      return createSign("RSA-SHA256").update(payload).end().sign(key.privateKey);
    },
    publicJwk(kid) {
      const key = keys.get(kid);
      if (!key) {
        throw new Error(`unknown KMS key: ${kid}`);
      }
      return { ...key.publicKey.export({ format: "jwk" }), kid, alg: ALGORITHM, use: "sig" };
    },
    exportPrivateKey() {
      throw new Error("durable signing keys are non-exportable");
    }
  };
}

export function bootstrapIdentityIssuer({ issuerUrl, kms, genesisKeyId, mode = "online", seedCredential }) {
  if (!issuerUrl) {
    throw new Error("issuerUrl is required");
  }
  if (!kms.hasKey(genesisKeyId)) {
    if (!seedCredential?.canGenerateGenesisKey) {
      throw new Error("seed credential cannot generate genesis key");
    }
    kms.generateRsaKey(genesisKeyId);
  }

  return new YardIdentityIssuer({
    issuerUrl,
    kms,
    genesisKeyId,
    mode,
    activeKeyId: genesisKeyId,
    jwksKeyIds: [genesisKeyId]
  });
}

export async function verifyJwtWithJwks(token, jwks, { issuer, audience, now }) {
  const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedClaims || !encodedSignature) {
    throw new Error("JWT must have three segments");
  }

  const header = JSON.parse(fromBase64Url(encodedHeader).toString("utf8"));
  const claims = JSON.parse(fromBase64Url(encodedClaims).toString("utf8"));
  const key = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (!key) {
    throw new Error(`JWKS does not contain kid ${header.kid}`);
  }
  if (header.alg !== ALGORITHM) {
    throw new Error(`unsupported alg ${header.alg}`);
  }

  const verifier = createVerify("RSA-SHA256").update(`${encodedHeader}.${encodedClaims}`).end();
  const valid = verifier.verify(createPublicKey({ key, format: "jwk" }), fromBase64Url(encodedSignature));
  if (!valid) {
    throw new Error("JWT signature verification failed");
  }
  if (claims.iss !== issuer) {
    throw new Error("issuer mismatch");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) {
    throw new Error("audience mismatch");
  }
  if (claims.exp <= now) {
    throw new Error("JWT is expired");
  }
  if (claims.nbf > now) {
    throw new Error("JWT is not yet valid");
  }

  return { header, claims };
}

class YardIdentityIssuer {
  constructor({ issuerUrl, kms, genesisKeyId, mode, activeKeyId, jwksKeyIds }) {
    this.issuerUrl = issuerUrl;
    this.kms = kms;
    this.genesisKeyId = genesisKeyId;
    this.mode = mode;
    this.activeKeyId = activeKeyId;
    this.jwksKeyIds = jwksKeyIds;
  }

  profile() {
    return { mode: this.mode, egress: this.mode === "airgap" ? "disabled" : "allowed" };
  }

  discovery() {
    return {
      issuer: this.issuerUrl,
      jwks_uri: `${this.issuerUrl}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: [ALGORITHM],
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"]
    };
  }

  jwks() {
    return { keys: this.jwksKeyIds.map((kid) => this.kms.publicJwk(kid)) };
  }

  async signJwtSvid(claims) {
    const header = { alg: ALGORITHM, kid: this.activeKeyId, typ: "JWT" };
    const payload = { ...claims, iss: this.issuerUrl };
    const signingInput = `${toBase64UrlJson(header)}.${toBase64UrlJson(payload)}`;
    const signature = this.kms.sign(this.activeKeyId, signingInput);
    return `${signingInput}.${toBase64Url(signature)}`;
  }

  selfDeploy({ issuerUrl, genesisKeyId }) {
    if (issuerUrl !== this.issuerUrl) {
      throw new Error("issuer continuity invariant failed");
    }
    if (genesisKeyId !== this.genesisKeyId) {
      throw new Error("genesis key continuity invariant failed");
    }
    return new YardIdentityIssuer({
      issuerUrl: this.issuerUrl,
      kms: this.kms,
      genesisKeyId: this.genesisKeyId,
      mode: this.mode,
      activeKeyId: this.activeKeyId,
      jwksKeyIds: this.jwksKeyIds
    });
  }

  rotateSigningKey(nextKeyId) {
    this.kms.generateRsaKey(nextKeyId);
    return new YardIdentityIssuer({
      issuerUrl: this.issuerUrl,
      kms: this.kms,
      genesisKeyId: this.genesisKeyId,
      mode: this.mode,
      activeKeyId: nextKeyId,
      jwksKeyIds: [...new Set([...this.jwksKeyIds, nextKeyId])]
    });
  }
}

function toBase64UrlJson(value) {
  return toBase64Url(Buffer.from(JSON.stringify(value)));
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url");
}

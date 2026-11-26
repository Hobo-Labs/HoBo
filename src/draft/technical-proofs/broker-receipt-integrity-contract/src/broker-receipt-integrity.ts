import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { isJsonObject, type JsonValue } from "./json.js";


const TEST_KEY_PAIR = generateKeyPairSync("ed25519");
const TEST_PUBLIC_KEY_PEM = TEST_KEY_PAIR.publicKey.export({ format: "pem", type: "spki" }).toString();
export type ReceiptVerificationContext = Readonly<{
  issuer: "meta-cloud-broker";
  keyId: string;
  publicKeyPem: string;
}>;

export type ReceiptExpectation = Readonly<{
  tenantId: string;
  environmentId: string;
  manifestDigest: string;
  brokerSnapshotDigest: string;
  minSchemaVersion: number;
}>;

export type ResolutionReceiptPayload = Readonly<{
  receiptId: string;
  issuer: "meta-cloud-broker";
  schemaVersion: number;
  tenantId: string;
  environmentId: string;
  manifestDigest: string;
  brokerSnapshotDigest: string;
  issuedAt: string;
  expiresAt: string;
  gatekeeperBoundary: "policy-after-receipt";
  handoff: {
    decision: "accepted";
    resourceBindings: ReadonlyArray<{
      resourceId: string;
      providerCapabilityDigest: string;
      mappingDigest: string;
    }>;
  };
}>;

export type ResolutionReceipt = Readonly<{
  payload: ResolutionReceiptPayload;
  digest: string;
  signature: string;
  signatureAlgorithm: "Ed25519";
  keyId: string;
}>;

type AcceptedReceipt = Readonly<{
  kind: "accepted";
  receiptId: string;
  authority: "meta-cloud-broker";
  gatekeeperBoundary: "policy-after-receipt";
  debugEvidence: SupportSafeReceiptEvidence;
}>;

type RejectedReceipt = Readonly<{
  kind: "rejected";
  reason: ReceiptRejectionReason;
  debugEvidence: SupportSafeReceiptEvidence;
}>;

export type ReceiptVerificationResult = AcceptedReceipt | RejectedReceipt;

export type ReceiptRejectionReason = Readonly<{
  code:
    | "receipt-integrity-failed"
    | "receipt-expired"
    | "receipt-downgrade-refused"
    | "receipt-tenant-mismatch"
    | "receipt-environment-mismatch"
    | "receipt-snapshot-mismatch"
    | "receipt-manifest-mismatch"
    | "receipt-replay-refused"
    | "receipt-gatekeeper-boundary-invalid";
  message: string;
  supportSafe: true;
}>;

type SupportSafeReceiptEvidence = Readonly<{
  receiptId: string;
  tenantId: string;
  environmentId: string;
  manifestDigest: string;
  brokerSnapshotDigest: string;
  supportSafe: true;
}>;

export function createReceiptVerificationContext(): ReceiptVerificationContext {
  return Object.freeze({
    issuer: "meta-cloud-broker",
    keyId: "broker-test-ed25519-2026-06",
    publicKeyPem: TEST_PUBLIC_KEY_PEM,
  });
}

export function buildSignedResolutionReceiptFixture(
  context: ReceiptVerificationContext,
  payloadOverrides: Partial<ResolutionReceiptPayload> = {},
): ResolutionReceipt {
  const payload: ResolutionReceiptPayload = Object.freeze({
    receiptId: payloadOverrides.receiptId ?? "receipt-shop-prod-001",
    issuer: payloadOverrides.issuer ?? context.issuer,
    schemaVersion: payloadOverrides.schemaVersion ?? 2,
    tenantId: payloadOverrides.tenantId ?? "tenant-alpha",
    environmentId: payloadOverrides.environmentId ?? "prod-us",
    manifestDigest: payloadOverrides.manifestDigest ?? "sha256:manifest-shop-prod",
    brokerSnapshotDigest:
      payloadOverrides.brokerSnapshotDigest ?? "sha256:broker-snapshot-prod-001",
    issuedAt: payloadOverrides.issuedAt ?? "2026-06-30T20:20:00.000Z",
    expiresAt: payloadOverrides.expiresAt ?? "2026-07-01T20:20:00.000Z",
    gatekeeperBoundary: payloadOverrides.gatekeeperBoundary ?? "policy-after-receipt",
    handoff: payloadOverrides.handoff ?? {
      decision: "accepted",
      resourceBindings: [
        {
          resourceId: "cache",
          providerCapabilityDigest: "sha256:capability-cache-prod",
          mappingDigest: "sha256:mapping-cache-prod",
        },
        {
          resourceId: "api",
          providerCapabilityDigest: "sha256:capability-api-prod",
          mappingDigest: "sha256:mapping-api-prod",
        },
      ],
    },
  });
  const digest = receiptDigest(payload);
  const privateKey = TEST_KEY_PAIR.privateKey;

  return Object.freeze({
    payload,
    digest,
    signature: sign(null, Buffer.from(digest), privateKey).toString("base64"),
    signatureAlgorithm: "Ed25519",
    keyId: context.keyId,
  });
}

export function verifyResolutionReceipt({
  context,
  receipt,
  now,
  expected,
  seenReceiptIds = new Set<string>(),
}: Readonly<{
  context: ReceiptVerificationContext;
  receipt: ResolutionReceipt;
  now: Date;
  expected: ReceiptExpectation;
  seenReceiptIds?: ReadonlySet<string>;
}>): ReceiptVerificationResult {
  const evidence = supportSafeEvidence(receipt.payload);
  const expectedDigest = receiptDigest(receipt.payload);
  const publicKey = createPublicKey(context.publicKeyPem);
  const hasValidSignature =
    receipt.signatureAlgorithm === "Ed25519" &&
    receipt.keyId === context.keyId &&
    receipt.digest === expectedDigest &&
    verify(null, Buffer.from(expectedDigest), publicKey, Buffer.from(receipt.signature, "base64"));

  if (!hasValidSignature) {
    return reject(evidence, "receipt-integrity-failed", "Receipt digest or signature does not verify.");
  }
  if (Date.parse(receipt.payload.expiresAt) <= now.getTime()) {
    return reject(evidence, "receipt-expired", "Receipt is expired for this verification time.");
  }
  if (receipt.payload.schemaVersion < expected.minSchemaVersion) {
    return reject(evidence, "receipt-downgrade-refused", "Receipt schema version is below the accepted floor.");
  }
  if (receipt.payload.tenantId !== expected.tenantId) {
    return reject(evidence, "receipt-tenant-mismatch", "Receipt tenant does not match request tenant.");
  }
  if (receipt.payload.environmentId !== expected.environmentId) {
    return reject(
      evidence,
      "receipt-environment-mismatch",
      "Receipt environment does not match request environment.",
    );
  }
  if (receipt.payload.brokerSnapshotDigest !== expected.brokerSnapshotDigest) {
    return reject(
      evidence,
      "receipt-snapshot-mismatch",
      "Receipt broker snapshot does not match expected broker snapshot.",
    );
  }
  if (receipt.payload.manifestDigest !== expected.manifestDigest) {
    return reject(evidence, "receipt-manifest-mismatch", "Receipt manifest does not match request manifest.");
  }
  if (seenReceiptIds.has(receipt.payload.receiptId)) {
    return reject(evidence, "receipt-replay-refused", "Receipt id was already consumed.");
  }
  if (receipt.payload.gatekeeperBoundary !== "policy-after-receipt") {
    return reject(
      evidence,
      "receipt-gatekeeper-boundary-invalid",
      "Receipt must leave Gatekeeper as an apply-time boundary.",
    );
  }

  return Object.freeze({
    kind: "accepted",
    receiptId: receipt.payload.receiptId,
    authority: "meta-cloud-broker",
    gatekeeperBoundary: receipt.payload.gatekeeperBoundary,
    debugEvidence: evidence,
  });
}

function reject(
  debugEvidence: SupportSafeReceiptEvidence,
  code: ReceiptRejectionReason["code"],
  message: string,
): RejectedReceipt {
  return Object.freeze({
    kind: "rejected",
    reason: Object.freeze({ code, message, supportSafe: true }),
    debugEvidence,
  });
}

function supportSafeEvidence(payload: ResolutionReceiptPayload): SupportSafeReceiptEvidence {
  return Object.freeze({
    receiptId: payload.receiptId,
    tenantId: payload.tenantId,
    environmentId: payload.environmentId,
    manifestDigest: payload.manifestDigest,
    brokerSnapshotDigest: payload.brokerSnapshotDigest,
    supportSafe: true,
  });
}

function receiptDigest(payload: ResolutionReceiptPayload): string {
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

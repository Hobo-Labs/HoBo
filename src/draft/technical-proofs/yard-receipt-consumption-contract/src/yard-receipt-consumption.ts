import { createHash } from "node:crypto";
import { isJsonString, isJsonObject, type JsonValue } from "./json.js";


const DEFAULT_PROTOCOL_VERSION = "yard-receipt-consumption/v1";
const DEFAULT_ISSUER = "meta-cloud-broker";

export type ResourcePlan = Readonly<{
  resourceId: string;
  provider: string;
  action: "provision" | "deploy" | "bind";
}>;

// domain-view: parse-produced draft-proof record; its wire form is the ResolutionReceipt proto message in data-models/.
export type ResolutionReceipt = {
  receiptId: string;
  protocolVersion: string;
  issuer: string;
  manifestDigest: string;
  environmentDigest: string;
  catalogSnapshotDigest: string;
  issuedAt: string;
  expiresAt: string;
  compatibility: {
    yardProtocolVersion: string;
  };
  handoffFacts: {
    resourcePlans: ResourcePlan[];
    gatekeeperMode: "policy-after-receipt";
  };
  digest: string;
  signature: string;
};

export type YardPlanningInput = Readonly<{
  source: "resolution-receipt";
  receiptId: string;
  brokerAuthority: "meta-cloud-broker";
  resolutionAuthority: "meta-cloud-broker";
  planningAuthority: "yard-control-plane";
  mayRecomputeBrokerMapping: false;
  manifestDigest: string;
  environmentDigest: string;
  catalogSnapshotDigest: string;
  resourcePlans: ResourcePlan[];
  auditEvent: {
    type: "ReceiptConsumedForPlanning";
    receiptId: string;
    manifestDigest: string;
    environmentDigest: string;
  };
}>;

type ConsumeReceiptInput = Readonly<{
  receipt?: ResolutionReceipt;
  now: Date;
  yardProtocolVersion: string;
  brokerResolver?: () => ResolutionReceipt;
}>;

type ReceiptOverrides = Partial<
  Omit<ResolutionReceipt, "handoffFacts" | "compatibility" | "digest" | "signature">
> & {
  protocolVersion?: string;
  expiresAt?: string;
  resourcePlans?: ResourcePlan[];
  yardProtocolVersion?: string;
};

type GatekeeperDecision = Readonly<{
  effect: "allow" | "allow-with-obligation" | "block";
  obligations?: string[];
  rewriteResourcePlans?: ResourcePlan[];
}>;

export function buildSignedReceiptFixture(overrides: ReceiptOverrides = {}): ResolutionReceipt {
  const receipt: Omit<ResolutionReceipt, "digest" | "signature"> = {
    receiptId: overrides.receiptId ?? "receipt-shop-prod-001",
    protocolVersion: overrides.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    issuer: overrides.issuer ?? DEFAULT_ISSUER,
    manifestDigest: overrides.manifestDigest ?? "sha256:manifest-shop-prod",
    environmentDigest: overrides.environmentDigest ?? "sha256:broker-env-prod",
    catalogSnapshotDigest: overrides.catalogSnapshotDigest ?? "sha256:catalog-prod-2026-06-29",
    issuedAt: overrides.issuedAt ?? "2026-06-29T20:55:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-06-30T20:55:00.000Z",
    compatibility: {
      yardProtocolVersion: overrides.yardProtocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    },
    handoffFacts: {
      resourcePlans: overrides.resourcePlans ?? [
        { resourceId: "cache", provider: "provider.alpha", action: "provision" },
        { resourceId: "api", provider: "provider.alpha", action: "deploy" },
      ],
      gatekeeperMode: "policy-after-receipt",
    },
  };
  const digest = receiptDigest(receipt);
  return {
    ...receipt,
    digest,
    signature: signatureFor({ issuer: receipt.issuer, digest }),
  };
}

export function consumeResolutionReceipt(input: ConsumeReceiptInput): YardPlanningInput {
  const parsed = parseResolutionReceipt(input);

  return Object.freeze({
    source: "resolution-receipt",
    receiptId: parsed.receiptId,
    brokerAuthority: "meta-cloud-broker",
    resolutionAuthority: "meta-cloud-broker",
    planningAuthority: "yard-control-plane",
    mayRecomputeBrokerMapping: false,
    manifestDigest: parsed.manifestDigest,
    environmentDigest: parsed.environmentDigest,
    catalogSnapshotDigest: parsed.catalogSnapshotDigest,
    resourcePlans: parsed.handoffFacts.resourcePlans.map((plan) => Object.freeze({ ...plan })),
    auditEvent: Object.freeze({
      type: "ReceiptConsumedForPlanning",
      receiptId: parsed.receiptId,
      manifestDigest: parsed.manifestDigest,
      environmentDigest: parsed.environmentDigest,
    }),
  });
}

export function rejectAdminReceiptMutation(_input: {
  actor: "admin-console" | string;
  receipt: ResolutionReceipt;
  patch: JsonValue;
}) {
  return {
    allowed: false,
    reason: "admin-mutation-refused:new-receipt-required",
  } as const;
}

export function resolveGatekeeperHandoff({
  planningInput,
  decision,
}: {
  planningInput: YardPlanningInput;
  decision: GatekeeperDecision;
}) {
  if (decision.rewriteResourcePlans !== undefined) {
    throw new Error("gatekeeper-rewrite-refused:new-receipt-or-policy-decision-required");
  }

  return {
    effect: decision.effect,
    obligations: decision.obligations ?? [],
    receiptId: planningInput.receiptId,
    resourcePlans: planningInput.resourcePlans,
  };
}

function parseResolutionReceipt({
  receipt,
  now,
  yardProtocolVersion,
}: ConsumeReceiptInput): ResolutionReceipt {
  if (!receipt) {
    throw new Error("receipt-required:no-broker-reresolve");
  }
  if (receipt.issuer !== DEFAULT_ISSUER) {
    throw new Error("receipt-authority-invalid");
  }
  if (receipt.protocolVersion !== yardProtocolVersion) {
    throw new Error("receipt-incompatible:protocol-version");
  }
  if (receipt.compatibility?.yardProtocolVersion !== yardProtocolVersion) {
    throw new Error("receipt-incompatible:yard-protocol");
  }
  if (Date.parse(receipt.expiresAt) <= now.getTime()) {
    throw new Error("receipt-stale:expired");
  }
  if (receipt.handoffFacts?.gatekeeperMode !== "policy-after-receipt") {
    throw new Error("receipt-incompatible:gatekeeper-mode");
  }
  if (!Array.isArray(receipt.handoffFacts.resourcePlans) || receipt.handoffFacts.resourcePlans.length === 0) {
    throw new Error("receipt-incompatible:resource-plans-required");
  }
  for (const plan of receipt.handoffFacts.resourcePlans) {
    parseResourcePlan(plan);
  }

  const expectedDigest = receiptDigest(withoutProof(receipt));
  const expectedSignature = signatureFor({ issuer: receipt.issuer, digest: expectedDigest });
  if (receipt.digest !== expectedDigest || receipt.signature !== expectedSignature) {
    throw new Error("receipt-integrity-failed:digest-or-signature");
  }

  return receipt;
}

function parseResourcePlan(plan: ResourcePlan) {
  if (!isNonEmptyString(plan.resourceId)) {
    throw new Error("receipt-incompatible:resource-id-required");
  }
  if (!isNonEmptyString(plan.provider)) {
    throw new Error("receipt-incompatible:provider-required");
  }
  if (!["provision", "deploy", "bind"].includes(plan.action)) {
    throw new Error("receipt-incompatible:resource-action");
  }
}

function receiptDigest(receipt: Omit<ResolutionReceipt, "digest" | "signature">) {
  return `sha256:${createHash("sha256").update(canonicalJson(receipt)).digest("hex")}`;
}

function signatureFor({ issuer, digest }: { issuer: string; digest: string }) {
  return `signed:${issuer}:${digest}`;
}

function withoutProof(receipt: ResolutionReceipt): Omit<ResolutionReceipt, "digest" | "signature"> {
  const { digest: _digest, signature: _signature, ...payload } = receipt;
  return payload;
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

function isNonEmptyString(value: JsonValue): value is string {
  return isJsonString(value) && value.trim().length > 0;
}

import { isJsonObject } from "./json.js";
export const TRUST_TIERS = [
  "generated-sandbox",
  "verified-publisher",
  "hosted-curated",
  "enterprise-private",
];

export const REQUIRED_TRUST_EVIDENCE = [
  "publisher-identity",
  "artifact-provenance",
  "conformance",
  "security-review",
  "deprecation-yank",
  "customer-warning",
];

export const REQUIRED_HANDOFFS = [
  "artifact-provenance",
  "registry-distribution",
  "org-catalogs",
  "support-handoff",
];

const REQUIRED_UNSUPPORTED_CLAIMS = [
  "unreviewed-third-party",
  "paid-marketplace",
  "rating-as-safety-proof",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /marketplace review ui/i,
  /paid publisher/i,
  /monetization/i,
  /storefront/i,
  /review service implementation/i,
];

export const MARKETPLACE_PUBLISHER_TRUST_EVIDENCE = {
  schema: "hobo.marketplace-publisher-trust-evidence/v1",
  issue: "HOBO-503",
  project: "Capability Review & Approval",
  phase: "M0",
  goal:
    "Define v1 marketplace and capability publisher trust tiers, review evidence, and customer-visible launch limitations without building marketplace review UI.",
  scopeIn: [
    "Publisher trust tiers for generated sandbox listings, verified publishers, hosted curated listings, and enterprise-private catalogs.",
    "Evidence requirements for publisher identity, artifact provenance, conformance, security review, deprecation/yank behavior, and customer warnings.",
    "Handoffs to artifact provenance, Registry distribution, org catalogs, and support surfaces.",
    "Unsupported marketplace claims documented as v1 launch limitations or blockers.",
  ],
  scopeOut: [
    "Do not build marketplace review UI, publisher portal UI, or storefront flows.",
    "Do not create monetization, paid tiers, revenue sharing, or payout behavior.",
    "Do not replace artifact signing, trust-tier policy enforcement, curated catalog policy, or SBOM/notice evidence contracts.",
  ],
  adversarialGuard:
    "Ratings, signed provenance, or verified identity are not enough on their own; installable marketplace claims require explicit security review and curation evidence.",
  trustTiers: [
    trustTier({
      id: "generated-sandbox",
      title: "Generated sandbox capability",
      publisherIdentity: "HoBo generation pipeline identity, model/prompt provenance, and responsible HoBo owner.",
      installDisposition: "limited-beta",
      customerWarning:
        "Generated capabilities are sandbox/beta only until a human review and curation decision makes them installable.",
    }),
    trustTier({
      id: "verified-publisher",
      title: "Verified external publisher",
      publisherIdentity: "Verified organization identity, signing key ownership, and contact/support channel.",
      installDisposition: "limited-beta",
      customerWarning:
        "Verified publisher identity does not imply HoBo curation; production install requires org policy or hosted curation.",
    }),
    trustTier({
      id: "hosted-curated",
      title: "Hosted HoBo curated listing",
      publisherIdentity: "Verified publisher plus HoBo hosted catalog approval record.",
      installDisposition: "installable",
      customerWarning:
        "Installable through the hosted curated catalog subject to policy, provenance, conformance, yank, and support evidence.",
    }),
    trustTier({
      id: "enterprise-private",
      title: "Enterprise private catalog listing",
      publisherIdentity: "Org-owned publisher identity and private catalog approval record.",
      installDisposition: "installable",
      customerWarning:
        "Installable only inside the approving org catalog; external marketplace endorsement is not implied.",
    }),
  ],
  unsupportedClaims: [
    {
      id: "unreviewed-third-party",
      launchDisposition: "blocked",
      ownerRoute: "Capability Review & Approval",
      customerMessage:
        "Third-party capabilities without review evidence are not presented as installable in v1.",
    },
    {
      id: "paid-marketplace",
      launchDisposition: "launch-limitation",
      ownerRoute: "V1 Release Program & Cutline",
      customerMessage:
        "HoBo v1 does not claim paid marketplace, payout, revenue-share, or commercial publisher tiers.",
    },
    {
      id: "rating-as-safety-proof",
      launchDisposition: "blocked",
      ownerRoute: "Security Verification",
      customerMessage:
        "Ratings or usage counts cannot replace provenance, conformance, curation, or security review evidence.",
    },
  ],
  dependencies: [
    "docs/design/adr/07-portability-extensibility.md#adr-0062",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/07-portability-extensibility.md#adr-0075",
    "docs/design/sbom-vulnerability-notice-evidence.md",
    "src/draft/technical-proofs/trust-tier-policy-contract/README.md",
    "src/draft/technical-proofs/curated-catalog-policy-contract/README.md",
  ],
};

export function classifyLaunchDispositions(record) {
  return {
    installable: (record.trustTiers ?? [])
      .filter((tier) => tier.installDisposition === "installable")
      .map((tier) => tier.id),
    limitedBeta: (record.trustTiers ?? [])
      .filter((tier) => tier.installDisposition === "limited-beta")
      .map((tier) => tier.id),
    blocked: (record.unsupportedClaims ?? []).map((claim) => claim.id),
  };
}

export function validateMarketplacePublisherTrustEvidence(record) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["marketplace publisher trust evidence record is required"] };
  }

  if (record.issue !== "HOBO-503") {
    errors.push("issue must be HOBO-503");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!record.adversarialGuard) {
    errors.push("adversarial guard is required");
  }

  for (const entry of record.scopeIn ?? []) {
    for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(entry)) {
        errors.push(`scope creep: ${entry}`);
      }
    }
  }

  const tierIds = new Set((record.trustTiers ?? []).map((tier) => tier.id));
  for (const id of TRUST_TIERS) {
    if (!tierIds.has(id)) {
      errors.push(`missing trust tier ${id}`);
    }
  }

  for (const tier of record.trustTiers ?? []) {
    validateTrustTier(tier, errors);
  }

  const unsupportedIds = new Set((record.unsupportedClaims ?? []).map((claim) => claim.id));
  for (const id of REQUIRED_UNSUPPORTED_CLAIMS) {
    if (!unsupportedIds.has(id)) {
      errors.push(`missing unsupported claim ${id}`);
    }
  }

  for (const claim of record.unsupportedClaims ?? []) {
    if (!claim.customerMessage || !claim.ownerRoute) {
      errors.push(`${claim.id ?? "<missing>"} must include customer message and owner route`);
    }
    if (!["blocked", "launch-limitation"].includes(claim.launchDisposition)) {
      errors.push(`${claim.id ?? "<missing>"} launchDisposition must be blocked or launch-limitation`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function trustTier({ id, title, publisherIdentity, installDisposition, customerWarning }) {
  return {
    id,
    title,
    publisherIdentity,
    installDisposition,
    customerWarning,
    evidence: REQUIRED_TRUST_EVIDENCE.map((kind) => evidenceRecord(id, kind)),
    handoffs: REQUIRED_HANDOFFS.map((kind) => handoffRecord(id, kind)),
  };
}

function evidenceRecord(tierId, kind) {
  return {
    kind,
    source: evidenceSource(tierId, kind),
    ownerRoute: evidenceOwner(kind),
  };
}

function handoffRecord(tierId, kind) {
  return {
    kind,
    target: handoffTarget(kind),
    requiredInput: `${tierId} ${kind} evidence`,
  };
}

function evidenceSource(tierId, kind) {
  if (kind === "publisher-identity") {
    return `${tierId} publisher identity verification record`;
  }
  if (kind === "artifact-provenance") {
    return `${tierId} signed artifact provenance and retained build lineage`;
  }
  if (kind === "conformance") {
    return `${tierId} capability conformance report and certified listing descriptor`;
  }
  if (kind === "security-review") {
    return `${tierId} capability review approval, threat notes, and vulnerability exception record`;
  }
  if (kind === "deprecation-yank") {
    return `${tierId} deprecation, yank, and revocation behavior record`;
  }
  return `${tierId} customer-visible warning text and limitation owner`;
}

function evidenceOwner(kind) {
  if (kind === "publisher-identity") {
    return "Capability Review & Approval";
  }
  if (kind === "artifact-provenance") {
    return "Provenance & Retention";
  }
  if (kind === "conformance") {
    return "Registry Distribution";
  }
  if (kind === "security-review") {
    return "Security Verification";
  }
  if (kind === "deprecation-yank") {
    return "Release Channels";
  }
  return "Launch Messaging & Claims";
}

function handoffTarget(kind) {
  if (kind === "artifact-provenance") {
    return "Release artifact provenance and retention handoff";
  }
  if (kind === "registry-distribution") {
    return "ADR-0062 Registry listing lifecycle";
  }
  if (kind === "org-catalogs") {
    return "Org Catalogs and curated catalog policy";
  }
  return "Launch support escalation and debug handoff";
}

function validateTrustTier(tier, errors) {
  if (!tier.publisherIdentity) {
    errors.push(`${tier.id ?? "<missing>"} missing publisher identity`);
  }
  if (!tier.customerWarning) {
    errors.push(`${tier.id ?? "<missing>"} must include customer warning`);
  }
  if (!tier.installDisposition) {
    errors.push(`${tier.id ?? "<missing>"} missing install disposition`);
  }
  if (
    tier.installDisposition === "installable" &&
    !["hosted-curated", "enterprise-private"].includes(tier.id)
  ) {
    errors.push(`${tier.id} cannot be installable without hosted or enterprise curation`);
  }

  const evidenceKinds = new Map((tier.evidence ?? []).map((item) => [item.kind, item]));
  for (const kind of REQUIRED_TRUST_EVIDENCE) {
    if (!evidenceKinds.has(kind)) {
      errors.push(`${tier.id ?? "<missing>"} missing evidence ${kind}`);
    }
  }

  for (const item of tier.evidence ?? []) {
    if (!item.source || !item.ownerRoute) {
      errors.push(`${tier.id ?? "<missing>"} ${item.kind ?? "<missing>"} must name source and owner route`);
    }
    if (
      item.kind === "security-review" &&
      /rating|provenance/i.test(item.source ?? "") &&
      /safe|review|security/i.test(item.source ?? "")
    ) {
      errors.push("ratings or provenance cannot substitute for security review evidence");
    }
  }

  const handoffKinds = new Set((tier.handoffs ?? []).map((handoff) => handoff.kind));
  for (const kind of REQUIRED_HANDOFFS) {
    if (!handoffKinds.has(kind)) {
      errors.push(`${tier.id ?? "<missing>"} missing handoff ${kind}`);
    }
  }
}

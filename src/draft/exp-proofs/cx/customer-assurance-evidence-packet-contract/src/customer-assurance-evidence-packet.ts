import { type JsonValue } from "./json.js";
type CustomerAssuranceSectionId =
  | "dpa-needs"
  | "subprocessors-providers"
  | "data-flow-summary"
  | "control-summary"
  | "security-evidence"
  | "backup-dr-evidence"
  | "support-obligations"
  | "known-gaps";

type ReadinessState =
  | "accepted"
  | "needs-owner-review"
  | "blocked-unavailable"
  | "explicit-launch-limitation";

type LegalArtifactAvailability = "available" | "unavailable";

type LegalArtifactDisposition = "ready" | "launch-blocker" | "explicit-launch-limitation";

type CustomerAssuranceSection = Readonly<{
  id: CustomerAssuranceSectionId;
  owner: string;
  sourceEvidence: string;
  betaReadiness: ReadinessState;
  gaReadiness: ReadinessState;
  customerMessage: string;
}>;

type LegalArtifact = Readonly<{
  id:
    | "dpa-template"
    | "privacy-notice"
    | "subprocessor-list"
    | "security-claims-review"
    | "support-obligation-summary";
  availability: LegalArtifactAvailability;
  disposition: LegalArtifactDisposition;
  owner: string;
  customerSafeStatus: string;
}>;

type InitiativeDependency = Readonly<{
  owner: string;
  boundary: string;
}>;

type M1Evidence = Readonly<{
  id:
    | "assurance-packet-outline"
    | "source-evidence-register"
    | "legal-artifact-disposition"
    | "customer-facing-claim-map"
    | "support-escalation-handoff"
    | "scope-boundary-register";
  mode: string;
  proves: string;
}>;

type CustomerAssuranceEvidencePacket = Readonly<{
  issue: "HOBO-493";
  project: "Compliance Evidence Pack";
  phase: "M0";
  goal: string;
  sections: readonly CustomerAssuranceSection[];
  legalArtifacts: readonly LegalArtifact[];
  scopeIn: readonly string[];
  scopeOut: readonly string[];
  nonGoals: readonly string[];
  designRefs: readonly string[];
  adrRefs: readonly string[];
  initiativeDependencies: readonly InitiativeDependency[];
  m1Evidence: readonly M1Evidence[];
  followUpGate: Readonly<{
    rule: string;
  }>;
}>;

type MutableCustomerAssuranceEvidencePacket = Omit<CustomerAssuranceEvidencePacket, "scopeIn"> & {
  scopeIn: string[];
};

type PacketValidationTarget = Partial<CustomerAssuranceEvidencePacket> & {
  sections?: readonly Partial<CustomerAssuranceSection>[];
  legalArtifacts?: readonly Partial<LegalArtifact>[];
  m1Evidence?: readonly Partial<M1Evidence>[];
  scopeIn?: readonly string[];
};

type FollowUpGateRequest = Readonly<{
  phase: string;
  m0Accepted: boolean;
}>;

type GateDecision = Readonly<{
  allowed: boolean;
  reason: string;
}>;

type WorkClassification = Readonly<{
  owner: string;
  inScope: boolean;
}>;

const REQUIRED_SECTION_IDS = Object.freeze([
  "dpa-needs",
  "subprocessors-providers",
  "data-flow-summary",
  "control-summary",
  "security-evidence",
  "backup-dr-evidence",
  "support-obligations",
  "known-gaps",
]) satisfies readonly CustomerAssuranceSectionId[];

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "assurance-packet-outline",
  "source-evidence-register",
  "legal-artifact-disposition",
  "customer-facing-claim-map",
  "support-escalation-handoff",
  "scope-boundary-register",
]) satisfies readonly M1Evidence["id"][];

const REQUIRED_LEGAL_ARTIFACTS = Object.freeze([
  "dpa-template",
  "privacy-notice",
  "subprocessor-list",
  "security-claims-review",
  "support-obligation-summary",
]) satisfies readonly LegalArtifact["id"][];

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "legal approval",
    pattern: /\b(approve|approval|signoff|publish)\b.{0,80}\b(dpa|legal terms|privacy notice|privacy policy|terms)\b/i,
  },
  {
    label: "proofless public claim",
    pattern: /\b(publish|claim|market)\b.{0,80}\b(soc2|compliance|security|privacy)\b.{0,80}\bwithout evidence\b/i,
  },
  {
    label: "subprocessor approval",
    pattern: /\b(approve|approval|publish)\b.{0,80}\bsubprocessor\b/i,
  },
]);

export const CUSTOMER_ASSURANCE_EVIDENCE_PACKET: CustomerAssuranceEvidencePacket = Object.freeze({
  issue: "HOBO-493",
  project: "Compliance Evidence Pack",
  phase: "M0",
  goal:
    "Define the customer assurance evidence packet outline for DPA needs, subprocessors, data flows, controls, security evidence, backup and disaster recovery, support obligations, and launch gaps without granting legal approval or publishing unsupported claims.",
  sections: Object.freeze([
    {
      id: "dpa-needs",
      owner: "Legal, Privacy & Terms Readiness",
      sourceEvidence: "Legal/privacy launch checklist plus tenant data lifecycle inventory.",
      betaReadiness: "blocked-unavailable",
      gaReadiness: "needs-owner-review",
      customerMessage:
        "DPA content is a launch blocker until legal owner provides or approves final terms.",
    },
    {
      id: "subprocessors-providers",
      owner: "Legal, Privacy & Terms Readiness",
      sourceEvidence: "Legal/privacy checklist, provider claim register, and tenant data inventory.",
      betaReadiness: "explicit-launch-limitation",
      gaReadiness: "needs-owner-review",
      customerMessage:
        "Provider and subprocessor statements distinguish required, optional, mocked, and unsupported services.",
    },
    {
      id: "data-flow-summary",
      owner: "Compliance Evidence Pack",
      sourceEvidence: "Tenant data lifecycle classes, retention posture, deletion/export obligations, and residency sensitivity.",
      betaReadiness: "accepted",
      gaReadiness: "needs-owner-review",
      customerMessage:
        "Customer data flow summaries stay tied to accepted data classes and retained limitations.",
    },
    {
      id: "control-summary",
      owner: "Compliance Evidence Pack",
      sourceEvidence: "Governance, tenant isolation, entitlement, and support boundary records.",
      betaReadiness: "needs-owner-review",
      gaReadiness: "needs-owner-review",
      customerMessage:
        "Control summaries list source evidence and gaps instead of claiming certification.",
    },
    {
      id: "security-evidence",
      owner: "Security Verification",
      sourceEvidence: "Security verification, SBOM/provenance, vulnerability process, and launch blocker gates.",
      betaReadiness: "needs-owner-review",
      gaReadiness: "needs-owner-review",
      customerMessage:
        "Security claims require accepted verification evidence before customer publication.",
    },
    {
      id: "backup-dr-evidence",
      owner: "Backup & Restore",
      sourceEvidence: "Backup source inventory, restore drill plan, RPO/RTO targets, and recovery handoff.",
      betaReadiness: "explicit-launch-limitation",
      gaReadiness: "needs-owner-review",
      customerMessage:
        "Backup and disaster recovery claims stay limited until drill evidence is accepted.",
    },
    {
      id: "support-obligations",
      owner: "Support Workflow",
      sourceEvidence: "Support SLA/channel scope, escalation matrix, support data routing, and manual review handoff.",
      betaReadiness: "needs-owner-review",
      gaReadiness: "needs-owner-review",
      customerMessage:
        "Support obligations state response paths and unsupported requests without promising unowned SLAs.",
    },
    {
      id: "known-gaps",
      owner: "Compliance Evidence Pack",
      sourceEvidence: "Legal/privacy unknowns, tenant data limitations, launch blockers, and release cutline records.",
      betaReadiness: "accepted",
      gaReadiness: "accepted",
      customerMessage:
        "Known gaps are customer-facing limitations or blockers with owners and follow-up routes.",
    },
  ]),
  legalArtifacts: Object.freeze([
    {
      id: "dpa-template",
      availability: "unavailable",
      disposition: "launch-blocker",
      owner: "Legal, Privacy & Terms Readiness",
      customerSafeStatus: "Do not promise DPA availability until legal owner provides approved text.",
    },
    {
      id: "privacy-notice",
      availability: "unavailable",
      disposition: "launch-blocker",
      owner: "Legal, Privacy & Terms Readiness",
      customerSafeStatus: "Public privacy statements wait for privacy owner review.",
    },
    {
      id: "subprocessor-list",
      availability: "unavailable",
      disposition: "explicit-launch-limitation",
      owner: "Legal, Privacy & Terms Readiness",
      customerSafeStatus: "Enterprise assurance packet marks unconfirmed subprocessors as a limitation.",
    },
    {
      id: "security-claims-review",
      availability: "available",
      disposition: "ready",
      owner: "Security Verification",
      customerSafeStatus: "Only evidence-backed security statements can be reused.",
    },
    {
      id: "support-obligation-summary",
      availability: "available",
      disposition: "ready",
      owner: "Support Workflow",
      customerSafeStatus: "Support scope can be summarized without promising unowned SLA commitments.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define the customer assurance packet outline for DPA needs, subprocessors/providers, data flow summary, control summary, security evidence, backup/DR evidence, support obligations, and known gaps.",
    "Record owner, source evidence, beta readiness state, GA readiness state, and customer-safe message for each packet section.",
    "Classify unavailable legal artifacts as launch blockers or explicit launch limitations.",
    "Map legal/privacy, tenant data lifecycle, security verification, backup/restore, support, and provenance handoffs.",
    "List M1 evidence required before customer-facing assurance packet publication or implementation work can fan out.",
  ]),
  scopeOut: Object.freeze([
    "No final DPA, privacy policy, legal terms, or legal approval claim.",
    "No subprocessor approval or provider legal commitment without legal owner signoff.",
    "No public SOC2, compliance, security, privacy, or provider claim without accepted source evidence.",
    "No live customer assurance portal, support desk workflow, legal workflow, or customer data mutation.",
    "No M1-M4 follow-up implementation issue creation before M0 packet acceptance is recorded.",
  ]),
  nonGoals: Object.freeze([
    "Replace legal, privacy, security, backup, or support owner approval.",
    "Draft final legal text or DPA terms.",
    "Publish customer assurance claims without accepted evidence.",
    "Implement customer assurance portal or automated evidence collection.",
  ]),
  designRefs: Object.freeze([
    "docs/design/legal-privacy-terms-readiness.md",
    "docs/design/tenant-data-lifecycle.md",
    "docs/design/security-verification.md",
    "docs/design/backup-restore.md",
    "docs/design/support-sla-channels.md",
    "docs/design/provenance-retention.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/02-identity-security.md#adr-0023",
    "docs/design/adr/02-identity-security.md#adr-0060",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/02-identity-security.md#adr-0080",
    "docs/design/adr/07-portability-extensibility.md#adr-0064",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Compliance Evidence Pack",
      boundary:
        "Owns assurance packet outline, source evidence register, known gaps, readiness states, and M0 follow-up gate.",
    },
    {
      owner: "Legal, Privacy & Terms Readiness",
      boundary:
        "Owns DPA, privacy notice, legal terms, subprocessor list approval, and legal launch blocker disposition.",
    },
    {
      owner: "Security Verification",
      boundary:
        "Owns security claim evidence, vulnerability process evidence, and customer-publishable security posture.",
    },
    {
      owner: "Backup & Restore",
      boundary:
        "Owns backup source inventory, restore drill evidence, RPO/RTO statements, and DR limitation wording.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Owns support obligations, escalation routing, manual review, and support-data customer communication.",
    },
    {
      owner: "Provenance & Retention",
      boundary:
        "Owns release artifact provenance, retention classes, invalidation/yank evidence, and support debug access.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "assurance-packet-outline",
      mode: "design-record",
      proves: "Packet sections exist for DPA, subprocessors, data flows, controls, security, backup/DR, support, and gaps.",
    },
    {
      id: "source-evidence-register",
      mode: "evidence-map",
      proves: "Each section cites owner and source evidence instead of freeform launch prose.",
    },
    {
      id: "legal-artifact-disposition",
      mode: "policy-fixture",
      proves: "Unavailable legal artifacts are blockers or explicit launch limitations.",
    },
    {
      id: "customer-facing-claim-map",
      mode: "claim-register",
      proves: "Customer-facing claims map to accepted evidence and known limitation wording.",
    },
    {
      id: "support-escalation-handoff",
      mode: "support-handoff",
      proves: "Customer assurance requests route to support, legal, security, backup, or compliance owners.",
    },
    {
      id: "scope-boundary-register",
      mode: "contract-test",
      proves: "Legal approval, subprocessor approval, proofless claims, portal implementation, and customer mutation route elsewhere.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 customer assurance evidence packet follow-up issues only after this M0 packet outline and executable proof are accepted.",
  }),
});

export function canCreateCustomerAssuranceFollowUp({ phase, m0Accepted }: FollowUpGateRequest): GateDecision {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return { allowed: true, reason: "Phase does not depend on the M0 customer assurance packet gate." };
  }

  if (m0Accepted) {
    return { allowed: true, reason: "M0 customer assurance packet scope has been accepted." };
  }

  return {
    allowed: false,
    reason: "M1-M4 follow-up work waits for accepted M0 customer assurance evidence packet scope.",
  };
}

export function classifyCustomerAssuranceWork(decision: JsonValue): WorkClassification {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(dpa|legal terms|privacy notice|privacy policy|subprocessor|legal)\b/.test(text)) {
    return { owner: "Legal, Privacy & Terms Readiness", inScope: false };
  }
  if (/\b(security|vulnerability|sbom|provenance claim|compliance claim)\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\b(backup|restore|dr|disaster recovery|rpo|rto)\b/.test(text)) {
    return { owner: "Backup & Restore", inScope: false };
  }
  if (/\b(support|escalation|customer request|manual review)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  return { owner: "Compliance Evidence Pack", inScope: true };
}

export interface PacketValidationOutcome {
  readonly ok: boolean;
  readonly errors: string[];
}

export function validateCustomerAssuranceEvidencePacket(
  packet: PacketValidationTarget,
): PacketValidationOutcome {
  const errors = [];

  if (packet?.issue !== "HOBO-493") {
    errors.push("Packet must be tied to HOBO-493.");
  }
  if (packet?.phase !== "M0") {
    errors.push("Packet must remain an M0 acceptance record.");
  }

  const sectionIds = new Set(packet.sections?.map((section) => section.id) ?? []);
  for (const sectionId of REQUIRED_SECTION_IDS) {
    if (!sectionIds.has(sectionId)) {
      errors.push(`Missing customer assurance section: ${sectionId}.`);
    }
  }

  for (const section of packet.sections ?? []) {
    if (!section.owner || !section.sourceEvidence || !section.betaReadiness || !section.gaReadiness) {
      errors.push(`Customer assurance section ${section.id ?? "<unknown>"} is missing readiness fields.`);
    }
  }

  const legalArtifactIds = new Set(packet.legalArtifacts?.map((artifact) => artifact.id) ?? []);
  for (const artifactId of REQUIRED_LEGAL_ARTIFACTS) {
    if (!legalArtifactIds.has(artifactId)) {
      errors.push(`Missing legal artifact disposition: ${artifactId}.`);
    }
  }

  for (const artifact of packet.legalArtifacts ?? []) {
    if (!artifact.owner || !artifact.customerSafeStatus) {
      errors.push(`Legal artifact ${artifact.id ?? "<unknown>"} is missing owner or customer-safe status.`);
    }
    if (
      artifact.availability === "unavailable" &&
      artifact.disposition !== "launch-blocker" &&
      artifact.disposition !== "explicit-launch-limitation"
    ) {
      errors.push(`Unavailable legal artifact ${artifact.id ?? "<unknown>"} must be blocker or limitation.`);
    }
  }

  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!packet.m1Evidence?.some((entry) => entry.id === evidence)) {
      errors.push(`Missing M1 evidence: ${evidence}.`);
    }
  }

  for (const item of packet.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(item)) {
        errors.push(`M0 scope-in includes out-of-scope ${label} work: ${item}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function cloneMutableCustomerAssuranceEvidencePacket(): MutableCustomerAssuranceEvidencePacket {
  return {
    ...CUSTOMER_ASSURANCE_EVIDENCE_PACKET,
    scopeIn: [...CUSTOMER_ASSURANCE_EVIDENCE_PACKET.scopeIn],
  };
}

import { isJsonObject } from "./json.js";
export type ThreatReviewPhase = "M0" | "M1" | "M2" | "M3" | "M4";
export type ThreatReviewSeverity = "critical" | "high" | "medium" | "low";
export type ThreatReviewExploitability = "public" | "bounded" | "theoretical";

const IMPLEMENTATION_PHASES = new Set<ThreatReviewPhase>(["M1", "M2", "M3", "M4"]);

export const REQUIRED_OPERATING_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const REQUIRED_INTAKE_FIELDS = Object.freeze([
  "asset-surface",
  "threat-scenario",
  "trust-boundary",
  "exploitability",
  "customer-impact",
  "credential-or-data-risk",
  "evidence-link",
  "fix-verification-plan",
]);

export const REQUIRED_REVIEW_GATES = Object.freeze([
  "beta-threat-intake",
  "release-candidate-security-review",
  "ga-security-signoff",
  "fix-verification-rerun",
  "support-and-disclosure-handoff",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "live scanner",
    pattern: /\b(implement|build|ship|wire|run)\b.{0,80}\b(live scanner|scanner|sast|dast|siem|exploit runner)\b/i,
  },
  {
    label: "gate bypass",
    pattern: /\b(bypass|skip|waive|override)\b.{0,80}\b(security gates?|release gates?|required gates?|review gates?)\b/i,
  },
  {
    label: "legal copy",
    pattern: /\b(final advisory copy|legal terms|privacy notice|public advisory|security-page copy)\b/i,
  },
]);

export const THREAT_MODEL_SECURITY_REVIEW_SCOPE = {
  schema: "hobo.threat-model-security-review-scope/v1",
  issue: "HOBO-451",
  project: "Threat Model & Security Review",
  phase: "M0" as const,
  goal:
    "Define Threat Model & Security Review M0 scope so v1 release owners know threat intake, review gates, evidence ownership, and support/security handoffs before live scanning or security workflow work begins.",
  sourceRefs: [
    "Linear HOBO-451 issue body",
    "docs/design/threat-model-security-review.md",
    "docs/design/security-verification.md",
    "docs/design/launch-blocker-taxonomy.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/incident-communications.md",
    "docs/design/legal-privacy-terms-readiness.md",
  ],
  personas: [
    {
      id: "security-reviewer",
      need: "Owns threat intake, severity rationale, required-gate review, and fix-verification evidence.",
    },
    {
      id: "release-owner",
      need: "Needs beta, RC, and GA security review state that cannot appear green without evidence.",
    },
    {
      id: "product-owner",
      need: "Needs scope-specific threat findings mapped to product surfaces and follow-up ownership.",
    },
    {
      id: "support-operator",
      need: "Receives customer-safe handoff language for known limitations and security escalation.",
    },
    {
      id: "customer-admin",
      need: "Needs honest assurance state without raw exploit notes or unsupported security claims.",
    },
  ],
  scopeIn: [
    "Name the user/business goal and primary personas for v1 Threat Model & Security Review.",
    "Record threat-review intake fields for product surface, trust boundary, exploitability, customer impact, credential/data exposure, evidence, and fix verification.",
    "Map service, UX, security, and support boundaries without implementing scanners, exploit runners, or workflow tooling.",
    "Map owning initiative dependencies for Security Verification, release cutline, support escalation, incident communications, and legal/privacy signoff.",
    "List M1 evidence required before design and contract proof issues can fan out.",
    "Record beta, release-candidate, GA, fix-verification, and support/disclosure review gates.",
    "Classify security findings into launch-blocking and non-blocking release states using evidence, severity, exploitability, and verified-fix state.",
  ],
  scopeOut: [
    "No live scanner, SAST, DAST, SIEM, exploit runner, runtime security service, or customer environment scan implementation.",
    "No security-gate bypass, merge-protection bypass, or review-waiver mechanism.",
    "No final advisory copy, legal terms, privacy notice, public security page, bug bounty, CVE CNA, or disclosure portal commitment.",
    "No incident service, ticketing service, customer-notification service, support queue, or release dashboard implementation.",
    "No raw exploit reproduction storage in customer-visible views.",
  ],
  nonGoals: [
    "Approve HoBo v1 as secure for beta, RC, or GA.",
    "Replace the Security Verification launch gate owned by HOBO-441.",
    "Implement vulnerability scanning, incident communications, legal approvals, or support tooling.",
    "Create child M1-M4 execution work before the M0 scope record is accepted.",
  ],
  operatingBoundaries: [
    {
      id: "service",
      owner: "Threat Model & Security Review",
      promise: "Owns threat-intake shape, review gates, finding classes, and proof requirements.",
    },
    {
      id: "ux",
      owner: "Threat Model & Security Review / Admin Console",
      promise: "May later expose review state, but M0 only defines fields and customer-safe visibility.",
    },
    {
      id: "security",
      owner: "Security Verification",
      promise: "Consumes threat-review evidence for launch blocker classification and fix verification.",
    },
    {
      id: "support",
      owner: "V1 Launch Support Desk & Escalation",
      promise: "Owns customer-safe support routing and limitation wording for security findings.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Threat Model & Security Review",
      boundary: "Owns this M0 scope record, threat-intake shape, and review-gate vocabulary.",
    },
    {
      owner: "Security Verification",
      boundary: "Consumes review findings for launch blocker state and fix-verification evidence.",
    },
    {
      owner: "V1 Release Program & Cutline",
      boundary: "Consumes beta, RC, and GA review state for release go/no-go decisions.",
    },
    {
      owner: "V1 Launch Support Desk & Escalation",
      boundary: "Owns customer-safe support routing for security findings and limitations.",
    },
    {
      owner: "Incident Communications",
      boundary: "Owns customer communications once confirmed impact or disclosure criteria exist.",
    },
    {
      owner: "V1 Legal, Privacy & Terms Readiness",
      boundary: "Owns legal/privacy signoff, public advisory posture, and final wording.",
    },
  ],
  intakeFields: [
    {
      id: "asset-surface",
      owner: "product-owner",
      minimumProof: "Names affected product, API, runtime, CLI, marketplace, tenant, or support surface.",
    },
    {
      id: "threat-scenario",
      owner: "security-reviewer",
      minimumProof: "States attacker capability, abuse path, and expected failed invariant.",
    },
    {
      id: "trust-boundary",
      owner: "security-reviewer",
      minimumProof: "Names tenant, identity, provider, runtime, support, data, or public boundary crossed.",
    },
    {
      id: "exploitability",
      owner: "security-reviewer",
      minimumProof: "Classifies public, bounded, or theoretical exploitability with evidence source.",
    },
    {
      id: "customer-impact",
      owner: "release-owner",
      minimumProof: "Records beta, RC, GA, support, or customer-assurance impact.",
    },
    {
      id: "credential-or-data-risk",
      owner: "security-reviewer",
      minimumProof: "States whether credentials, tenant data, billing data, support data, or generated artifacts are exposed.",
    },
    {
      id: "evidence-link",
      owner: "security-reviewer",
      minimumProof: "Links fixture, proof package, design record, issue, or reproduced finding.",
    },
    {
      id: "fix-verification-plan",
      owner: "security-reviewer",
      minimumProof: "Names regression, exploit reproduction, review, and release-gate rerun expectations.",
    },
  ],
  reviewGates: [
    {
      id: "beta-threat-intake",
      owner: "Threat Model & Security Review",
      minimumProof: "Private-beta security review intake fields are complete before beta claims.",
    },
    {
      id: "release-candidate-security-review",
      owner: "Security Verification",
      minimumProof: "Release-candidate threats are classified with blocker or accepted-risk state.",
    },
    {
      id: "ga-security-signoff",
      owner: "V1 Release Program & Cutline",
      minimumProof: "GA review state cites security, support, incident, and legal/privacy handoffs.",
    },
    {
      id: "fix-verification-rerun",
      owner: "Security Verification",
      minimumProof: "Release-affecting fixes rerun proof gates before downgrade or release.",
    },
    {
      id: "support-and-disclosure-handoff",
      owner: "V1 Launch Support Desk & Escalation",
      minimumProof: "Customer-safe support/disclosure owner and unsupported-state wording are named.",
    },
  ],
  followUpGate: {
    owner: "Threat Model & Security Review",
    rule: "M1-M4 follow-up issues may start only after HOBO-451 M0 scope acceptance is recorded.",
  },
} as const;

export function validateThreatModelSecurityReviewScope(record: typeof THREAT_MODEL_SECURITY_REVIEW_SCOPE) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["threat model security review scope record is required"] };
  }
  if (record.issue !== "HOBO-451") errors.push("issue must be HOBO-451");
  if (record.phase !== "M0") errors.push("phase must be M0");
  if (!record.goal || !/Threat Model & Security Review/i.test(record.goal)) {
    errors.push("goal must name Threat Model & Security Review");
  }

  for (const section of [
    "personas",
    "scopeIn",
    "scopeOut",
    "nonGoals",
    "initiativeDependencies",
    "intakeFields",
    "reviewGates",
  ] as const) {
    if (!Array.isArray(record[section]) || record[section].length === 0) {
      errors.push(`${section} must be a non-empty list`);
    }
  }

  const boundaryIds = new Set(record.operatingBoundaries?.map((boundary) => boundary.id) ?? []);
  for (const boundary of REQUIRED_OPERATING_BOUNDARIES) {
    if (!boundaryIds.has(boundary)) errors.push(`missing ${boundary} operating boundary`);
  }

  const intakeIds = new Set(record.intakeFields?.map((field) => field.id) ?? []);
  for (const field of REQUIRED_INTAKE_FIELDS) {
    if (!intakeIds.has(field)) errors.push(`missing ${field} intake field`);
  }

  const gateIds = new Set(record.reviewGates?.map((gate) => gate.id) ?? []);
  for (const gate of REQUIRED_REVIEW_GATES) {
    if (!gateIds.has(gate)) errors.push(`missing ${gate} review gate`);
  }

  const scopedText = [...(record.scopeIn ?? [])].join("\n");
  for (const forbidden of FORBIDDEN_SCOPE_PATTERNS) {
    if (forbidden.pattern.test(scopedText)) {
      errors.push(`scope creep: ${forbidden.label}`);
    }
  }

  if (!record.followUpGate?.rule || !/M1-M4/.test(record.followUpGate.rule)) {
    errors.push("follow-up gate must block M1-M4 work until M0 acceptance");
  }

  return { ok: errors.length === 0, errors };
}

export function canStartThreatReviewFollowUp({
  phase,
  m0Accepted,
}: {
  phase: ThreatReviewPhase;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) return { allowed: true };
  if (m0Accepted) return { allowed: true };
  return {
    allowed: false,
    reason: "Threat Model & Security Review M1-M4 follow-up work is blocked until HOBO-451 M0 scope is accepted.",
  };
}

export function classifyThreatReviewFinding({
  severity,
  exploitability,
  customerDataRisk,
  credentialExposure,
  fixVerified,
}: {
  severity: ThreatReviewSeverity;
  exploitability: ThreatReviewExploitability;
  customerDataRisk: boolean;
  credentialExposure: boolean;
  fixVerified: boolean;
}) {
  const launchBlocking =
    severity === "critical" ||
    (severity === "high" && exploitability !== "theoretical") ||
    customerDataRisk ||
    credentialExposure ||
    !fixVerified;

  if (launchBlocking) {
    return {
      class: "launch-blocker" as const,
      reason:
        "Critical or high exploitability, customer-data risk, credential exposure, or unverified release-affecting fix blocks launch.",
    };
  }

  if (severity === "medium") {
    return {
      class: "high-risk-non-blocker" as const,
      reason: "Medium findings require release-owner approval, mitigation, expiry, and customer-safe support wording.",
    };
  }

  return {
    class: "launch-note" as const,
    reason: "Low, verified findings route to release notes or post-GA follow-up without bypassing required gates.",
  };
}

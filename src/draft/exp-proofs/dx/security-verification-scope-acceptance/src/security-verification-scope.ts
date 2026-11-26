import { isJsonObject } from "./json.js";
export type SecurityVerificationPhase = "M0" | "M1" | "M2" | "M3" | "M4";

type ClaimAudience = "internal" | "release-notes" | "public-docs" | "customer-assurance";

const IMPLEMENTATION_PHASES = new Set<SecurityVerificationPhase>(["M1", "M2", "M3", "M4"]);

export const REQUIRED_OPERATING_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const REQUIRED_M1_EVIDENCE = Object.freeze([
  "scope-record",
  "threat-review-intake",
  "launch-blocker-taxonomy",
  "vulnerability-disclosure-process",
  "fix-verification-fixture",
  "support-escalation-handoff",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "live security service",
    pattern:
      /\b(implement|build|ship|launch|wire|run)\b.{0,80}\b(live vulnerability scanner|scanner|siem|runtime security service|production security service)\b/i,
  },
  {
    label: "bug bounty",
    pattern: /\b(external bug bounty|bug bounty commitment|bounty program|cve cna|vendor disclosure portal)\b/i,
  },
  {
    label: "ticketing workflow",
    pattern:
      /\b(ticketing workflow|support ticket service|incident service|customer notification service|notification service)\b/i,
  },
  {
    label: "legal terms",
    pattern: /\b(final legal terms|privacy notice|security-page copy|public advisory text|legal advisory terms)\b/i,
  },
]);

export const SECURITY_VERIFICATION_SCOPE = {
  schema: "hobo.security-verification-scope/v1",
  issue: "HOBO-441",
  project: "Security Verification",
  phase: "M0" as const,
  goal:
    "Define Security Verification M0 scope so v1 release owners know the security launch gate, evidence owners, support handoffs, and follow-up proof requirements before threat review or live workflow work begins.",
  sourceRefs: [
    "Linear HOBO-441 issue body",
    "docs/design/security-verification.md",
    "docs/design/launch-blocker-taxonomy.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/public-status-page-incident-communication.md",
    "docs/design/legal-privacy-terms-readiness.md",
  ],
  personas: [
    {
      id: "release-owner",
      need: "Needs a security go/no-go gate that distinguishes blockers, accepted risk, and unsupported claims.",
    },
    {
      id: "security-lead",
      need: "Owns severity, threat-review intake, fix verification, and launch-blocker disposition.",
    },
    {
      id: "support-operator",
      need: "Receives customer-safe escalation guidance without direct security-policy mutation authority.",
    },
    {
      id: "customer-admin",
      need: "Needs honest assurance evidence and known limitations before beta or paid GA adoption.",
    },
    {
      id: "legal-privacy-owner",
      need: "Owns disclosure, privacy, and advisory text signoff without approving unsupported security claims.",
    },
  ],
  scopeIn: [
    "Name the user/business goal and primary personas for v1 Security Verification.",
    "Record the M0 launch gate boundary for threat-review intake, launch blockers, disclosure process, fix verification, and support handoff evidence.",
    "Map service, UX, security, and support boundaries without implementing live workflow systems.",
    "Map owning initiative dependencies for release cutline, threat model, support escalation, incident communications, and legal/privacy signoff.",
    "List M1 evidence required before design and contract proof issues can fan out.",
    "Record the follow-up gate that blocks M1/M2/M3/M4 security-verification work until this M0 scope is accepted.",
  ],
  scopeOut: [
    "No live scanner, SIEM integration, ticketing workflow, incident service, or customer notification service.",
    "No public security page, final advisory text, legal terms, privacy notices, external bug bounty, or CVE CNA commitment.",
    "No production vulnerability-disclosure portal, support queue implementation, or security-review UI.",
    "No runtime security engine, policy engine, Gatekeeper change, tenant-control implementation, or exploit scanning integration.",
    "No public or release-facing security verification claim without named proof mode and source evidence.",
  ],
  nonGoals: [
    "Approve HoBo v1 as secure for beta or paid GA.",
    "Replace the vulnerability-disclosure launch-blocker contract owned by HOBO-494.",
    "Implement threat-model execution, scanner integrations, incident communications, or legal approvals.",
    "Create child M1-M4 implementation work before the M0 scope record is accepted.",
  ],
  operatingBoundaries: [
    {
      id: "service",
      owner: "Security Verification",
      promise:
        "Owns the launch security gate vocabulary, evidence matrix, M1 proof requirements, and follow-up gate.",
    },
    {
      id: "ux",
      owner: "Security Verification / Admin Console",
      promise:
        "May later expose review status, but this M0 issue only defines fields, states, and evidence expectations.",
    },
    {
      id: "security",
      owner: "Threat Model & Security Review",
      promise:
        "Owns threat intake, severity disposition, blocker criteria, and fix-verification evidence.",
    },
    {
      id: "support",
      owner: "V1 Launch Support Desk & Escalation",
      promise:
        "Owns customer-safe escalation paths and support handoff wording for security findings and known limitations.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Security Verification",
      boundary: "Owns this M0 scope record, evidence matrix, and follow-up gate.",
    },
    {
      owner: "Threat Model & Security Review",
      boundary: "Owns threat-review intake and severity review execution after M0 acceptance.",
    },
    {
      owner: "V1 Release Program & Cutline",
      boundary: "Consumes security blocker state in beta, RC, and GA go/no-go decisions.",
    },
    {
      owner: "V1 Launch Support Desk & Escalation",
      boundary: "Owns support routing and customer-safe escalation for security findings.",
    },
    {
      owner: "Incident Communications",
      boundary: "Owns customer communication templates once disclosure criteria are met.",
    },
    {
      owner: "V1 Legal, Privacy & Terms Readiness",
      boundary: "Owns legal/privacy signoff, final advisory text, and public security page posture.",
    },
  ],
  m1Evidence: [
    {
      id: "scope-record",
      owner: "Security Verification",
      minimumProof: "Accepted design record, traceability row, and executable scope package for HOBO-441.",
    },
    {
      id: "threat-review-intake",
      owner: "Threat Model & Security Review",
      minimumProof: "Fixture names intake fields, severity owner, exploitability, customer impact, and evidence links.",
    },
    {
      id: "launch-blocker-taxonomy",
      owner: "V1 Release Program & Cutline",
      minimumProof: "Security blocker states map to beta, RC, and GA go/no-go decisions.",
    },
    {
      id: "vulnerability-disclosure-process",
      owner: "Security Verification",
      minimumProof: "HOBO-494 process proof remains linked for intake, disclosure, embargo, and blocker criteria.",
    },
    {
      id: "fix-verification-fixture",
      owner: "Security Verification",
      minimumProof: "Regression, exploit reproduction, fix review, release-gate rerun, and impact assessment are required.",
    },
    {
      id: "support-escalation-handoff",
      owner: "V1 Launch Support Desk & Escalation",
      minimumProof: "Support handoff names customer-safe wording, routing owner, and unsupported-state handling.",
    },
  ],
  followUpGate: {
    owner: "Security Verification",
    rule: "M1-M4 follow-up issues may start only after HOBO-441 M0 scope acceptance is recorded.",
  },
} as const;

export function validateSecurityVerificationScope(record: typeof SECURITY_VERIFICATION_SCOPE) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["security verification scope record is required"] };
  }
  if (record.issue !== "HOBO-441") errors.push("issue must be HOBO-441");
  if (record.phase !== "M0") errors.push("phase must be M0");
  if (!record.goal || !/Security Verification/i.test(record.goal)) {
    errors.push("goal must name Security Verification");
  }

  for (const section of ["personas", "scopeIn", "scopeOut", "nonGoals", "initiativeDependencies", "m1Evidence"] as const) {
    if (!Array.isArray(record[section]) || record[section].length === 0) {
      errors.push(`${section} must be a non-empty list`);
    }
  }

  const boundaryIds = new Set(record.operatingBoundaries?.map((boundary) => boundary.id) ?? []);
  for (const boundary of REQUIRED_OPERATING_BOUNDARIES) {
    if (!boundaryIds.has(boundary)) errors.push(`missing ${boundary} operating boundary`);
  }

  const evidenceIds = new Set(record.m1Evidence?.map((evidence) => evidence.id) ?? []);
  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!evidenceIds.has(evidence)) errors.push(`missing ${evidence} M1 evidence`);
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

export function canStartSecurityVerificationFollowUp({
  phase,
  m0Accepted,
}: {
  phase: SecurityVerificationPhase;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) return { allowed: true };
  if (m0Accepted) return { allowed: true };
  return {
    allowed: false,
    reason: "Security Verification M1-M4 follow-up work is blocked until HOBO-441 M0 scope is accepted.",
  };
}

export function classifySecurityVerificationClaim({
  audience,
  proofMode,
  source,
}: {
  audience: ClaimAudience;
  claim: string;
  proofMode?: string;
  source?: string;
}) {
  const releaseFacing = audience !== "internal";
  if (releaseFacing && (!proofMode || !source)) {
    return {
      allowed: false,
      reason: "Release-facing security verification claims require proof mode and source evidence.",
    };
  }

  return { allowed: true };
}

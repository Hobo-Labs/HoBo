import { type JsonValue } from "./json.js";
export const REQUIRED_ASSURANCE_SECTIONS = Object.freeze([
  "security-posture",
  "tenant-data-lifecycle",
  "sbom-vulnerability-notices",
  "legal-privacy-terms",
  "backup-restore-dr",
  "support-sla-escalation",
  "release-cutline-risk",
] as const);

export const REQUIRED_M1_EVIDENCE = Object.freeze([
  "customer-assurance-packet-outline",
  "evidence-owner-matrix",
  "source-link-register",
  "gap-and-limitation-register",
  "customer-response-state-fixture",
  "launch-blocker-routing-fixture",
  "scope-boundary-guard",
] as const);

export const REQUIRED_PERSONAS = Object.freeze([
  "customer-security-reviewer",
  "privacy-legal-owner",
  "compliance-lead",
  "support-owner",
  "release-owner",
] as const);

export const REQUIRED_BOUNDARIES = Object.freeze([
  "service",
  "ux",
  "security",
  "support",
  "legal-privacy",
  "release",
] as const);

type AssuranceSectionId = (typeof REQUIRED_ASSURANCE_SECTIONS)[number];
type M1EvidenceId = (typeof REQUIRED_M1_EVIDENCE)[number];
type PersonaId = (typeof REQUIRED_PERSONAS)[number];
type BoundaryId = (typeof REQUIRED_BOUNDARIES)[number];

type Persona = Readonly<{
  id: PersonaId;
  need: string;
}>;

type AssuranceSection = Readonly<{
  id: AssuranceSectionId;
  ownerProject: string;
  sourceRecord: string;
  betaReadiness: "accepted" | "manual" | "limited" | "blocked";
  gaReadiness: "accepted" | "manual" | "blocked-until-evidence";
  blockerRoute: string;
  customerSafeLimitation: string;
}>;

type OwningInitiativeDependency = Readonly<{
  owner: string;
  consumes: string;
  boundary: string;
}>;

type ScopeBoundary = Readonly<{
  id: BoundaryId;
  owner: string;
  rule: string;
}>;

type M1Evidence = Readonly<{
  id: M1EvidenceId;
  owner: string;
  mode: string;
  proves: string;
}>;

type ComplianceEvidencePackScope = Readonly<{
  issue: "HOBO-452";
  project: "Compliance Evidence Pack";
  phase: "M0";
  goal: string;
  primaryPersonas: readonly Persona[];
  scopeIn: readonly string[];
  scopeOut: readonly string[];
  nonGoals: readonly string[];
  boundaries: readonly ScopeBoundary[];
  assuranceSections: readonly AssuranceSection[];
  designRefs: readonly string[];
  adrRefs: readonly string[];
  owningInitiativeDependencies: readonly OwningInitiativeDependency[];
  m1Evidence: readonly M1Evidence[];
  followUpGate: Readonly<{ rule: string }>;
}>;

type MutableComplianceEvidencePackScope = Omit<
  ComplianceEvidencePackScope,
  | "goal"
  | "primaryPersonas"
  | "scopeIn"
  | "scopeOut"
  | "nonGoals"
  | "boundaries"
  | "assuranceSections"
  | "owningInitiativeDependencies"
  | "m1Evidence"
> & {
  goal: string;
  primaryPersonas: Persona[];
  scopeIn: string[];
  scopeOut: string[];
  nonGoals: string[];
  boundaries: ScopeBoundary[];
  assuranceSections: AssuranceSection[];
  owningInitiativeDependencies: OwningInitiativeDependency[];
  m1Evidence: M1Evidence[];
};

type ValidationTarget = Partial<ComplianceEvidencePackScope> & {
  primaryPersonas?: readonly Partial<Persona>[];
  assuranceSections?: readonly Partial<AssuranceSection>[];
  boundaries?: readonly Partial<ScopeBoundary>[];
  owningInitiativeDependencies?: readonly Partial<OwningInitiativeDependency>[];
  m1Evidence?: readonly Partial<M1Evidence>[];
  scopeIn?: readonly string[];
  scopeOut?: readonly string[];
  nonGoals?: readonly string[];
};

type FollowUpGateRequest = Readonly<{
  phase: string;
  m0Accepted: boolean;
}>;

type GateDecision = Readonly<{
  allowed: boolean;
  reason: string;
}>;

type RequestClassification = Readonly<{
  owner: string;
  inScope: boolean;
}>;

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "legal approval",
    pattern: /\b(approve|ratify|publish|finalize)\b.{0,64}\b(dpa|subprocessor|privacy terms|legal terms|legal signoff)\b/i,
  },
  {
    label: "live compliance implementation",
    pattern: /\b(implement|build|integrate|ship)\b.{0,64}\b(live compliance portal|scanner|scanner integration|grc system|evidence collection service)\b/i,
  },
  {
    label: "support data access",
    pattern: /\b(grant|allow|approve)\b.{0,64}\b(production customer data|customer data access|tenant data access|break-glass access)\b/i,
  },
  {
    label: "proofless customer claim",
    pattern: /\b(publish|claim|announce|guarantee)\b.{0,80}\b(compliance certification|customer-facing compliance|assurance)\b.{0,80}\b(without linked evidence|without evidence|unproven)\b/i,
  },
] as const);

export const COMPLIANCE_EVIDENCE_PACK_SCOPE: ComplianceEvidencePackScope = Object.freeze({
  issue: "HOBO-452",
  project: "Compliance Evidence Pack",
  phase: "M0",
  goal:
    "Define the v1 compliance evidence packet scope, owners, evidence sources, customer-safe limitations, and follow-up gate before customer assurance, legal, support, security, or release claims can fan out.",
  primaryPersonas: Object.freeze([
    {
      id: "customer-security-reviewer",
      need: "Needs one evidence packet that separates accepted proof from beta limitations and missing evidence.",
    },
    {
      id: "privacy-legal-owner",
      need: "Needs DPA, subprocessor, privacy, and retention inputs without treating M0 as legal approval.",
    },
    {
      id: "compliance-lead",
      need: "Needs owner mapping, evidence states, and customer response boundaries for assurance requests.",
    },
    {
      id: "support-owner",
      need: "Needs a customer-safe routing matrix for evidence gaps, manual review, and escalation.",
    },
    {
      id: "release-owner",
      need: "Needs blocker and accepted-risk routes tied to beta, release-candidate, and GA cutlines.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define the customer assurance packet sections and the owner/source record for each section.",
    "Record beta and GA readiness states for each assurance section as accepted, manual, limited, or blocked.",
    "Map service, UX, security, support, legal/privacy, and release-cutline dependencies.",
    "List customer-safe limitations for sections that are manual, deferred, or not yet legally approved.",
    "Define M1 evidence required before evidence collection, customer response automation, legal publication, or launch claims fan out.",
  ]),
  scopeOut: Object.freeze([
    "Do not approve final DPA, privacy terms, legal terms, subprocessor list, or legal signoff.",
    "Do not implement live compliance portals, scanner integrations, evidence collection services, GRC systems, or customer response automation.",
    "Do not grant support, admin, or break-glass access to production customer data.",
    "Do not publish customer-facing compliance, security, privacy, or reliability claims without linked accepted evidence.",
    "Do not create M1-M4 follow-up implementation issues before M0 acceptance is recorded.",
  ]),
  nonGoals: Object.freeze([
    "Replace Legal, Privacy & Terms Readiness approval.",
    "Replace Security Verification, tenant data lifecycle, backup/restore, support, or release cutline records.",
    "Claim SOC2, ISO, compliance certification, production readiness, or formal audit completion.",
    "Collect or expose live customer data as part of this M0 scope record.",
  ]),
  boundaries: Object.freeze([
    boundary({
      id: "service",
      owner: "Compliance Evidence Pack",
      rule:
        "Records packet sections, owners, sources, readiness, blocker routes, limitations, and M1 evidence; does not build collection services or compliance portals.",
    }),
    boundary({
      id: "ux",
      owner: "Compliance Evidence Pack",
      rule:
        "Defines customer-safe packet vocabulary and response states for future UX; does not build portal, dashboard, or automated response flows.",
    }),
    boundary({
      id: "security",
      owner: "Security Verification",
      rule:
        "Names security evidence routes and blocked claims; does not certify posture, grant customer-data access, or bypass launch blockers.",
    }),
    boundary({
      id: "support",
      owner: "Support Workflow",
      rule:
        "Receives manual-review, escalation, limitation, and unavailable-claim routes; support queue implementation and customer-data access remain out of scope.",
    }),
    boundary({
      id: "legal-privacy",
      owner: "Legal, Privacy & Terms Readiness",
      rule:
        "Names legal and privacy dependencies and gaps; final DPA, subprocessor, terms, privacy notice, and legal approval stay with Legal.",
    }),
    boundary({
      id: "release",
      owner: "V1 Release Program & Cutline",
      rule:
        "Consumes gaps and accepted-risk states; go/no-go authority and public launch claims stay with the release program.",
    }),
  ]),
  assuranceSections: Object.freeze([
    assuranceSection({
      id: "security-posture",
      ownerProject: "Security Verification",
      sourceRecord: "docs/design/security-verification.md",
      betaReadiness: "manual",
      gaReadiness: "blocked-until-evidence",
      blockerRoute: "Security Verification triage and V1 Release Program & Cutline exception record.",
      customerSafeLimitation: "Security claims stay limited to verified launch-blocker and disclosure evidence.",
    }),
    assuranceSection({
      id: "tenant-data-lifecycle",
      ownerProject: "Tenant Data Lifecycle",
      sourceRecord: "docs/design/tenant-data-lifecycle.md",
      betaReadiness: "accepted",
      gaReadiness: "accepted",
      blockerRoute: "Compliance Evidence Pack routes missing data-class or deletion/export evidence back to HOBO-492 follow-ups.",
      customerSafeLimitation: "Deletion/export posture is an obligation matrix, not live deletion automation.",
    }),
    assuranceSection({
      id: "sbom-vulnerability-notices",
      ownerProject: "Compliance Evidence Pack",
      sourceRecord: "docs/design/sbom-vulnerability-notice-evidence.md",
      betaReadiness: "limited",
      gaReadiness: "blocked-until-evidence",
      blockerRoute: "Security Verification and release cutline decide vulnerability, notice, provenance, and retention gaps.",
      customerSafeLimitation: "SBOM/provenance evidence does not imply notice completeness or formal certification.",
    }),
    assuranceSection({
      id: "legal-privacy-terms",
      ownerProject: "Legal, Privacy & Terms Readiness",
      sourceRecord: "docs/design/tenant-data-lifecycle.md",
      betaReadiness: "blocked",
      gaReadiness: "blocked-until-evidence",
      blockerRoute: "Legal, Privacy & Terms Readiness owns DPA, subprocessors, privacy notice, terms, and retained exceptions.",
      customerSafeLimitation: "M0 packet can list legal gaps only; it cannot approve legal artifacts.",
    }),
    assuranceSection({
      id: "backup-restore-dr",
      ownerProject: "Backup & Restore",
      sourceRecord: "docs/design/backup-restore.md",
      betaReadiness: "manual",
      gaReadiness: "blocked-until-evidence",
      blockerRoute: "Backup & Restore owns RPO/RTO drill gaps and restore-evidence handoff.",
      customerSafeLimitation: "No recovery readiness claim without accepted restore-drill evidence.",
    }),
    assuranceSection({
      id: "support-sla-escalation",
      ownerProject: "Support Workflow",
      sourceRecord: "docs/design/support-sla-channels.md",
      betaReadiness: "manual",
      gaReadiness: "blocked-until-evidence",
      blockerRoute: "Support Workflow and Launch Support Escalation route support evidence gaps.",
      customerSafeLimitation: "Support routes do not grant customer data access or promise unsupported channels.",
    }),
    assuranceSection({
      id: "release-cutline-risk",
      ownerProject: "V1 Release Program & Cutline",
      sourceRecord: "docs/design/launch-blocker-taxonomy.md",
      betaReadiness: "manual",
      gaReadiness: "blocked-until-evidence",
      blockerRoute: "Release Program records go/no-go, accepted risk, exception expiry, and owner.",
      customerSafeLimitation: "Accepted risk must be named and time-bounded; missing evidence cannot appear green.",
    }),
  ]),
  designRefs: Object.freeze([
    "docs/design/security-verification.md",
    "docs/design/tenant-data-lifecycle.md",
    "docs/design/sbom-vulnerability-notice-evidence.md",
    "docs/design/support-sla-channels.md",
    "docs/design/backup-restore.md",
    "docs/design/launch-blocker-taxonomy.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/02-identity-security.md#adr-0023",
    "docs/design/adr/02-identity-security.md#adr-0060",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/07-portability-extensibility.md#adr-0064",
  ]),
  owningInitiativeDependencies: Object.freeze([
    dependency({
      owner: "Compliance Evidence Pack",
      consumes: "Accepted source records, owner matrix, gaps register, customer-safe limitation copy.",
      boundary: "Assembles evidence packet scope; does not certify or approve underlying evidence.",
    }),
    dependency({
      owner: "Legal, Privacy & Terms Readiness",
      consumes: "Tenant data lifecycle and assurance packet legal gaps.",
      boundary: "Owns DPA, subprocessors, privacy terms, legal terms, and final legal approval.",
    }),
    dependency({
      owner: "Security Verification",
      consumes: "Security posture, vulnerability, break-glass, audit, and customer-data risk signals.",
      boundary: "Owns severity, launch blockers, security claims, and fix verification.",
    }),
    dependency({
      owner: "Support Workflow",
      consumes: "Manual review states, escalation routes, support limitation copy, and customer response handoffs.",
      boundary: "Owns support channel execution and support data access controls.",
    }),
    dependency({
      owner: "Backup & Restore",
      consumes: "Data-class retention and recovery limitation evidence.",
      boundary: "Owns restore drills, RPO/RTO evidence, backup storage, and recovery execution.",
    }),
    dependency({
      owner: "V1 Release Program & Cutline",
      consumes: "Gaps, accepted risks, missing evidence, and launch blocker routes.",
      boundary: "Owns go/no-go decision record, exception expiry, and launch readiness rollup.",
    }),
  ]),
  m1Evidence: Object.freeze([
    evidence({
      id: "customer-assurance-packet-outline",
      owner: "Compliance Evidence Pack",
      mode: "design-record",
      proves: "Packet sections, customer-facing purpose, and unsupported claims are explicit.",
    }),
    evidence({
      id: "evidence-owner-matrix",
      owner: "Compliance Evidence Pack",
      mode: "owner-matrix",
      proves: "Every section has owner project, source record, beta state, GA state, and blocker route.",
    }),
    evidence({
      id: "source-link-register",
      owner: "Compliance Evidence Pack",
      mode: "link-check",
      proves: "Customer assurance sections cite accepted design records instead of untraceable narrative.",
    }),
    evidence({
      id: "gap-and-limitation-register",
      owner: "V1 Release Program & Cutline",
      mode: "policy-fixture",
      proves: "Manual, limited, deferred, and blocked sections are visible before customer-facing claims.",
    }),
    evidence({
      id: "customer-response-state-fixture",
      owner: "Support Workflow",
      mode: "support-handoff",
      proves: "Requests route to accepted evidence, limitation response, manual review, or unavailable claim.",
    }),
    evidence({
      id: "launch-blocker-routing-fixture",
      owner: "Security Verification",
      mode: "contract-test",
      proves: "Missing or failed evidence routes to security, legal, support, backup, or release owner.",
    }),
    evidence({
      id: "scope-boundary-guard",
      owner: "Compliance Evidence Pack",
      mode: "contract-test",
      proves: "Legal approval, live implementation, support data access, and proofless claims are rejected.",
    }),
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 compliance evidence implementation or customer-response issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateComplianceEvidenceFollowUp({
  phase,
  m0Accepted,
}: FollowUpGateRequest): GateDecision {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return { allowed: true, reason: "Phase does not depend on the M0 compliance evidence gate." };
  }

  if (m0Accepted) {
    return { allowed: true, reason: "M0 compliance evidence scope has been accepted." };
  }

  return {
    allowed: false,
    reason: "M1-M4 compliance evidence work waits for accepted M0 scope.",
  };
}

export function classifyComplianceEvidenceRequest(request: JsonValue): RequestClassification {
  const text = String(request ?? "").toLowerCase();

  if (/\b(dpa|subprocessor|privacy terms|legal terms|legal)\b/.test(text)) {
    return { owner: "Legal, Privacy & Terms Readiness", inScope: false };
  }
  if (/\b(vulnerability|security|break-glass|audit finding|severity)\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\b(tenant data|deletion|residency|retention matrix|data lifecycle)\b/.test(text)) {
    return { owner: "Tenant Data Lifecycle", inScope: false };
  }
  if (/\b(support|escalation|customer response|manual review)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }
  if (/\b(beta launch blocker|go\/no-go|cutline|accepted risk|exception)\b/.test(text)) {
    return { owner: "V1 Release Program & Cutline", inScope: false };
  }
  if (/\b(backup|restore|rpo|rto|disaster recovery)\b/.test(text)) {
    return { owner: "Backup & Restore", inScope: false };
  }

  return { owner: "Compliance Evidence Pack", inScope: true };
}

export function validateComplianceEvidencePackScope(
  scope: ValidationTarget,
): GateDecision & { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (scope.issue !== "HOBO-452") {
    errors.push("Scope record must be tied to HOBO-452.");
  }
  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }
  if (!scope.goal) {
    errors.push("Scope record must name the user/business goal.");
  }

  const personaIds = new Set(scope.primaryPersonas?.map((persona) => persona.id) ?? []);
  for (const persona of REQUIRED_PERSONAS) {
    if (!personaIds.has(persona)) {
      errors.push(`missing primary persona ${persona}`);
    }
  }
  for (const persona of scope.primaryPersonas ?? []) {
    if (!persona.need) {
      errors.push(`${persona.id ?? "<unknown-persona>"} missing need`);
    }
  }
  for (const section of ["scopeIn", "scopeOut", "nonGoals"] as const) {
    if ((scope[section] ?? []).length === 0) {
      errors.push(`${section} must be recorded.`);
    }
  }

  for (const entry of scope.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(entry)) {
        errors.push(`M0 scope-in includes out-of-scope ${label} work: ${entry}`);
      }
    }
  }

  const boundaryIds = new Set(scope.boundaries?.map((boundary) => boundary.id) ?? []);
  for (const boundaryId of REQUIRED_BOUNDARIES) {
    if (!boundaryIds.has(boundaryId)) {
      errors.push(`missing ${boundaryId} boundary`);
    }
  }
  for (const boundaryEntry of scope.boundaries ?? []) {
    if (!boundaryEntry.owner || !boundaryEntry.rule) {
      errors.push(`${boundaryEntry.id ?? "<unknown-boundary>"} missing owner or rule`);
    }
  }

  const sectionIds = new Set(scope.assuranceSections?.map((section) => section.id) ?? []);
  for (const sectionId of REQUIRED_ASSURANCE_SECTIONS) {
    if (!sectionIds.has(sectionId)) {
      errors.push(`missing assurance section ${sectionId}`);
    }
  }

  for (const section of scope.assuranceSections ?? []) {
    for (const field of [
      "ownerProject",
      "sourceRecord",
      "betaReadiness",
      "gaReadiness",
      "blockerRoute",
      "customerSafeLimitation",
    ] as const) {
      if (!section[field]) {
        errors.push(`${section.id ?? "<unknown-section>"} missing ${field}`);
      }
    }
  }

  for (const dependencyEntry of scope.owningInitiativeDependencies ?? []) {
    if (!dependencyEntry.owner || !dependencyEntry.consumes || !dependencyEntry.boundary) {
      errors.push(`${dependencyEntry.owner ?? "<unknown-dependency>"} missing owner, consumes, or boundary`);
    }
  }

  const m1EvidenceIds = new Set(scope.m1Evidence?.map((entry) => entry.id) ?? []);
  for (const evidenceId of REQUIRED_M1_EVIDENCE) {
    if (!m1EvidenceIds.has(evidenceId)) {
      errors.push(`missing M1 evidence ${evidenceId}`);
    }
  }
  for (const evidenceEntry of scope.m1Evidence ?? []) {
    if (!evidenceEntry.owner || !evidenceEntry.mode || !evidenceEntry.proves) {
      errors.push(`${evidenceEntry.id ?? "<unknown-evidence>"} missing owner, mode, or proof claim`);
    }
  }

  return {
    allowed: errors.length === 0,
    ok: errors.length === 0,
    reason: errors.length === 0 ? "Compliance evidence M0 scope is valid." : "Compliance evidence M0 scope has gaps.",
    errors,
  };
}

export function cloneMutableComplianceEvidencePackScope(): MutableComplianceEvidencePackScope {
  return {
    ...COMPLIANCE_EVIDENCE_PACK_SCOPE,
    primaryPersonas: COMPLIANCE_EVIDENCE_PACK_SCOPE.primaryPersonas.map((persona) => ({ ...persona })),
    scopeIn: [...COMPLIANCE_EVIDENCE_PACK_SCOPE.scopeIn],
    scopeOut: [...COMPLIANCE_EVIDENCE_PACK_SCOPE.scopeOut],
    nonGoals: [...COMPLIANCE_EVIDENCE_PACK_SCOPE.nonGoals],
    boundaries: COMPLIANCE_EVIDENCE_PACK_SCOPE.boundaries.map((entry) => ({ ...entry })),
    assuranceSections: COMPLIANCE_EVIDENCE_PACK_SCOPE.assuranceSections.map((section) => ({ ...section })),
    owningInitiativeDependencies: COMPLIANCE_EVIDENCE_PACK_SCOPE.owningInitiativeDependencies.map(
      (entry) => ({ ...entry }),
    ),
    m1Evidence: COMPLIANCE_EVIDENCE_PACK_SCOPE.m1Evidence.map((entry) => ({ ...entry })),
  };
}

function assuranceSection(section: AssuranceSection): AssuranceSection {
  return Object.freeze(section);
}

function dependency(dependency: OwningInitiativeDependency): OwningInitiativeDependency {
  return Object.freeze(dependency);
}

function boundary(boundary: ScopeBoundary): ScopeBoundary {
  return Object.freeze(boundary);
}

function evidence(evidence: M1Evidence): M1Evidence {
  return Object.freeze(evidence);
}

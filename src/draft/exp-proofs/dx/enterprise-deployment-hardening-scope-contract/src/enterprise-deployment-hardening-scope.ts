import { isJsonObject } from "./json.js";
export type EnterpriseHardeningPhase = "M0" | "M1" | "M2" | "M3" | "M4";

type EnterpriseReadinessAudience = "internal" | "release-notes" | "public-docs" | "customer-assurance";

const IMPLEMENTATION_PHASES = new Set<EnterpriseHardeningPhase>(["M1", "M2", "M3", "M4"]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const REQUIRED_DEPLOYMENT_POSTURES = Object.freeze([
  "managed-saas",
  "self-hosted-yard",
  "sovereign-air-gapped",
  "local-dev-simulation",
]);

export const REQUIRED_M1_EVIDENCE = Object.freeze([
  "deployment-mode-matrix",
  "enterprise-posture-checklist",
  "control-boundary-map",
  "tenant-environment-handoff",
  "backup-upgrade-rollback-handoff",
  "support-assurance-handoff",
  "follow-up-gate-record",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "production deployment runtime",
    pattern:
      /\b(implement|build|ship|launch|run|wire)\b.{0,100}\b(production installer|hosted control plane|cloud provisioning|managed service|self-host rollout|deployment runner)\b/i,
  },
  {
    label: "identity and tenant-control implementation",
    pattern:
      /\b(implement|build|ship|launch|wire)\b.{0,100}\b(RBAC|SSO|SCIM|policy engine|tenant isolation|quota enforcement|secret handling)\b/i,
  },
  {
    label: "backup, restore, or upgrade execution",
    pattern:
      /\b(run|execute|implement|build|ship|launch|automate)\b.{0,100}\b(backup restore|backup\/restore|restore jobs?|upgrade migrations?|rollback automation|DR exercises?|disaster recovery runner)\b/i,
  },
  {
    label: "commercial, legal, or support commitment",
    pattern:
      /\b(commit|approve|finalize|guarantee|promise)\b.{0,100}\b(SLA|legal|compliance|billing|paid support|contractual|enterprise sales|licensing)\b/i,
  },
]);

export const ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE = {
  schema: "hobo.enterprise-deployment-hardening-scope/v1",
  issue: "HOBO-453",
  project: "Enterprise Deployment Hardening",
  phase: "M0" as const,
  goal:
    "Define Enterprise Deployment Hardening M0 scope so release, platform, security, operations, and support owners know which deployment postures, evidence handoffs, and follow-up gates must be accepted before enterprise implementation work begins.",
  sourceRefs: [
    "Linear HOBO-453 issue body",
    "docs/design/enterprise-deployment-hardening.md",
    "docs/design/bootstrap-installer.md",
    "docs/design/upgrade-migration-engine.md",
    "docs/design/backup-restore.md",
    "docs/design/tenant-isolation-quotas.md",
    "docs/design/admin-console.md",
    "docs/design/support-sla-channels.md",
    "docs/design/security-verification.md",
    "docs/design/customer-assurance-evidence-packet.md",
    "docs/design/adr/02-identity-security.md#adr-0023",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/07-portability-extensibility.md#adr-0024",
    "docs/design/adr/07-portability-extensibility.md#adr-0036",
  ],
  personas: [
    {
      id: "enterprise-platform-owner",
      need: "Needs a deployment-mode promise that separates hosted SaaS, self-hosted Yard, and air-gapped expectations before committing enterprise rollout work.",
    },
    {
      id: "security-compliance-reviewer",
      need: "Needs identity, governance, audit, tenant isolation, and evidence-packet boundaries stated before customer assurance claims are made.",
    },
    {
      id: "devops-operator",
      need: "Needs upgrade, backup, rollback, observability, and unsupported-state handoffs without inheriting production runner scope in M0.",
    },
    {
      id: "support-lead",
      need: "Needs enterprise-safe escalation wording and ownership boundaries before support channels or SLA commitments are promised.",
    },
    {
      id: "release-owner",
      need: "Needs a cutline gate that prevents M1-M4 enterprise work and customer-facing readiness claims until M0 evidence is accepted.",
    },
  ],
  deploymentPostures: [
    {
      id: "managed-saas",
      owner: "V1 Release Program & Cutline",
      promise: "Names hosted-control-plane readiness questions and evidence owners without provisioning or operating a live service.",
    },
    {
      id: "self-hosted-yard",
      owner: "Bootstrap Installer",
      promise: "Names bootstrap, upgrade, backup, and operator-handoff expectations without building installers or deployment runners.",
    },
    {
      id: "sovereign-air-gapped",
      owner: "Portability, Registry & Distribution",
      promise: "Names mirror, provenance, support, and offline evidence gaps without certifying a sovereign rollout.",
    },
    {
      id: "local-dev-simulation",
      owner: "Developer Experience",
      promise: "Names mocked-enterprise fidelity limits so local proofs cannot be marketed as production deployment readiness.",
    },
  ],
  scopeIn: [
    "Name the user/business goal and primary personas for Enterprise Deployment Hardening.",
    "Define deployment posture classes for managed SaaS, self-hosted Yard, sovereign or air-gapped, and local-dev simulation evidence.",
    "Record tenant, org, environment, identity, governance, audit, backup, upgrade, rollback, support, and assurance evidence boundaries.",
    "Map service, UX, security, and support boundaries without implementing live deployment, identity, backup, support, or legal systems.",
    "Map authoritative design dependencies and owning initiatives that must accept M1 proof work.",
    "List M1 evidence required before design and contract proof issues can fan out.",
    "Record the follow-up gate that blocks M1/M2/M3/M4 enterprise hardening work until this M0 scope is accepted.",
  ],
  scopeOut: [
    "No production installer, deployment runner, hosted control plane, cloud provisioning, managed service setup, or self-host rollout.",
    "No RBAC, SSO, SCIM, policy engine, tenant isolation, quota enforcement, secret handling, or admin console implementation.",
    "No backup restore execution, upgrade migration, rollback automation, disaster recovery runner, or live resilience exercise.",
    "No support queue, SLA guarantee, legal approval, compliance certification, billing, enterprise sales, or licensing commitment.",
    "No customer-facing enterprise readiness claim without named proof source and owner route.",
  ],
  nonGoals: [
    "Approve HoBo as enterprise deployment ready.",
    "Replace the Bootstrap Installer, Upgrade & Migration Engine, Backup & Restore, Tenant Isolation & Quotas, Admin Console, Security Verification, Support SLA, or Customer Assurance initiatives.",
    "Create or execute production rollout mechanisms.",
    "Create child M1-M4 implementation work before the M0 scope record is accepted.",
  ],
  operatingBoundaries: [
    {
      id: "service",
      owner: "Enterprise Deployment Hardening",
      promise:
        "Owns deployment posture vocabulary, scope acceptance, M1 proof requirements, and follow-up gate state.",
    },
    {
      id: "ux",
      owner: "Admin Console / Developer Experience",
      promise:
        "May later expose readiness status, unsupported states, and troubleshooting entry points; this M0 issue only defines fields and evidence expectations.",
    },
    {
      id: "security",
      owner: "Identity, Governance, Security Verification",
      promise:
        "Owns identity, RBAC, audit, tenant isolation, and assurance evidence acceptance after this scope record is accepted.",
    },
    {
      id: "support",
      owner: "V1 Launch Support Desk & Escalation",
      promise:
        "Owns enterprise-safe escalation routes, unsupported-state wording, and support handoffs without SLA or paid-support commitments in M0.",
    },
  ],
  authoritativeDependencies: [
    {
      record: "docs/design/bootstrap-installer.md",
      reason: "Self-host bootstrap and installer evidence define the enterprise self-host posture boundary.",
    },
    {
      record: "docs/design/upgrade-migration-engine.md",
      reason: "Upgrade, rollback, and migration evidence define release-owner and operator hardening handoffs.",
    },
    {
      record: "docs/design/backup-restore.md",
      reason: "Backup, restore, and DR evidence define resilience claims and scope-out execution boundaries.",
    },
    {
      record: "docs/design/tenant-isolation-quotas.md",
      reason: "Tenant isolation, quotas, and fairness controls define security and governance dependencies.",
    },
    {
      record: "docs/design/admin-console.md",
      reason: "Admin-facing status, settings, and operator handoffs define future UX exposure boundaries.",
    },
    {
      record: "docs/design/support-sla-channels.md",
      reason: "Support channels, escalation ownership, and SLA language define support commitment boundaries.",
    },
    {
      record: "docs/design/security-verification.md",
      reason: "Security verification controls customer-facing readiness and accepted-risk language.",
    },
    {
      record: "docs/design/customer-assurance-evidence-packet.md",
      reason: "Assurance packets constrain public and customer-facing enterprise readiness claims.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Enterprise Deployment Hardening",
      boundary: "Owns this M0 scope record, posture matrix, M1 evidence list, and follow-up gate.",
    },
    {
      owner: "Bootstrap Installer",
      boundary: "Owns self-host bootstrap evidence after M0 acceptance.",
    },
    {
      owner: "Upgrade & Migration Engine",
      boundary: "Owns upgrade, migration, rollback, and compatibility proof after M0 acceptance.",
    },
    {
      owner: "Backup & Restore",
      boundary: "Owns backup, restore, and disaster-recovery evidence after M0 acceptance.",
    },
    {
      owner: "Tenant Isolation & Quotas",
      boundary: "Owns tenant isolation, quota, and governance proof after M0 acceptance.",
    },
    {
      owner: "Admin Console",
      boundary: "Owns future operator UI status surfaces after M0 acceptance.",
    },
    {
      owner: "V1 Launch Support Desk & Escalation",
      boundary: "Owns support routing and unsupported-state wording after M0 acceptance.",
    },
    {
      owner: "Customer Assurance Evidence Packet",
      boundary: "Owns customer-facing evidence packaging and claim limits after M0 acceptance.",
    },
  ],
  m1Evidence: [
    {
      id: "deployment-mode-matrix",
      owner: "Enterprise Deployment Hardening",
      minimumProof: "Managed SaaS, self-hosted Yard, sovereign or air-gapped, and local-dev simulation postures list evidence, gaps, and owners.",
    },
    {
      id: "enterprise-posture-checklist",
      owner: "V1 Release Program & Cutline",
      minimumProof: "Checklist covers identity, governance, audit, tenant isolation, backup, upgrade, support, and assurance gates.",
    },
    {
      id: "control-boundary-map",
      owner: "Identity, Governance, Security Verification",
      minimumProof: "Security and compliance controls map to source records and block customer-facing claims without proof.",
    },
    {
      id: "tenant-environment-handoff",
      owner: "Tenant Isolation & Quotas",
      minimumProof: "Tenant, org, environment, quota, and isolation handoffs name owners and deferred implementation work.",
    },
    {
      id: "backup-upgrade-rollback-handoff",
      owner: "Backup & Restore / Upgrade & Migration Engine",
      minimumProof: "Backup, restore, migration, upgrade, rollback, and DR evidence points to owning design records.",
    },
    {
      id: "support-assurance-handoff",
      owner: "Support SLA Channels / Customer Assurance Evidence Packet",
      minimumProof: "Support and assurance handoffs name allowed readiness language and unsupported-state handling.",
    },
    {
      id: "follow-up-gate-record",
      owner: "Enterprise Deployment Hardening",
      minimumProof: "M1-M4 child work remains blocked until HOBO-453 scope acceptance is recorded.",
    },
  ],
  followUpGate: {
    owner: "Enterprise Deployment Hardening",
    rule: "M1-M4 follow-up issues may start only after HOBO-453 M0 scope acceptance is recorded.",
  },
} as const;

export function validateEnterpriseDeploymentHardeningScope(
  record: typeof ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE,
) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["enterprise deployment hardening scope record is required"] };
  }
  if (record.issue !== "HOBO-453") errors.push("issue must be HOBO-453");
  if (record.phase !== "M0") errors.push("phase must be M0");
  if (!record.goal || !/Enterprise Deployment Hardening/i.test(record.goal)) {
    errors.push("goal must name Enterprise Deployment Hardening");
  }

  for (const section of [
    "personas",
    "deploymentPostures",
    "scopeIn",
    "scopeOut",
    "nonGoals",
    "authoritativeDependencies",
    "initiativeDependencies",
    "m1Evidence",
  ] as const) {
    if (!Array.isArray(record[section]) || record[section].length === 0) {
      errors.push(`${section} must be a non-empty list`);
    }
  }

  const boundaryIds = new Set(record.operatingBoundaries?.map((boundary) => boundary.id) ?? []);
  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!boundaryIds.has(boundary)) errors.push(`missing ${boundary} operating boundary`);
  }

  const postureIds = new Set(record.deploymentPostures?.map((posture) => posture.id) ?? []);
  for (const posture of REQUIRED_DEPLOYMENT_POSTURES) {
    if (!postureIds.has(posture)) errors.push(`missing ${posture} deployment posture`);
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

  return { ok: errors.length === 0, errors };
}

export function canStartEnterpriseHardeningFollowUp(input: {
  phase: EnterpriseHardeningPhase;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(input.phase)) {
    return { allowed: true, reason: "M0 scope work may define the gate." };
  }

  if (!input.m0Accepted) {
    return {
      allowed: false,
      reason: "M1-M4 enterprise deployment hardening work is blocked until HOBO-453 M0 scope acceptance.",
    };
  }

  return { allowed: true, reason: "HOBO-453 M0 scope acceptance is recorded." };
}

export function classifyEnterpriseReadinessClaim(input: {
  audience: EnterpriseReadinessAudience;
  claim: string;
  proofSource?: string;
  ownerRoute?: string;
}) {
  if (
    input.audience !== "internal" &&
    (!input.proofSource || !input.ownerRoute || !input.claim.trim())
  ) {
    return {
      allowed: false,
      reason: "Customer-facing enterprise readiness claims require proof source and owner route.",
    };
  }

  return { allowed: true, reason: "Claim has named proof source and owner route." };
}

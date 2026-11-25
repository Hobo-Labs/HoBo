type BreakGlassRoleId =
  | "support-operator"
  | "security-approver"
  | "incident-commander"
  | "customer-admin";

type BreakGlassEventId =
  | "breakglass.requested"
  | "breakglass.approved"
  | "breakglass.started"
  | "breakglass.used"
  | "breakglass.revoked";

interface BreakGlassRole {
  id: BreakGlassRoleId;
  responsibility: string;
}

interface AccessClass {
  id: string;
  owner: string;
  purpose: string;
  approvalPath: BreakGlassRoleId[];
  auditEvents: BreakGlassEventId[];
  maxTtlMinutes: number;
  customerNotification: string;
  revocation: string;
}

interface UnsupportedAction {
  id: string;
  reason: string;
}

interface BoundaryDependency {
  source: string;
  reason: string;
}

interface BreakGlassBoundaryContract {
  issue: string;
  phase: "M0";
  goal: string;
  defaultPosture: "deny-by-default";
  leastPrivilegeRule: string;
  maxTtlMinutes: number;
  customerNotificationPosture: string;
  revocationRule: string;
  roles: BreakGlassRole[];
  accessClasses: AccessClass[];
  unsupportedActions: UnsupportedAction[];
  requiredAuditEvents: BreakGlassEventId[];
  dependencies: BoundaryDependency[];
  scopeOut: string[];
}

interface ValidationResult {
  errors: string[];
}

interface BreakGlassSessionRequest {
  accessClassId: string;
  requestedBy: BreakGlassRoleId;
  approvedBy?: BreakGlassRoleId;
  now: string;
  expiresAt: string;
  auditEventIds: BreakGlassEventId[];
  customerNotificationDecision?: string;
}

interface SessionDecision {
  allowed: boolean;
  reason: string;
}

interface ClassifiedRequest {
  owner: string;
  accessClassId: string;
  inScope: boolean;
}

const REQUIRED_SESSION_EVENTS: BreakGlassEventId[] = [
  "breakglass.requested",
  "breakglass.approved",
  "breakglass.started",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /\bimplement(?:ation)?\b/i,
  /\bui\b/i,
  /\btooling\b/i,
  /\bstatic credential/i,
  /\bprovider credential/i,
  /\bunbounded\b/i,
  /\bsilent\b/i,
];

export const BREAK_GLASS_BOUNDARY_CONTRACT: BreakGlassBoundaryContract = {
  issue: "HOBO-495",
  phase: "M0",
  goal:
    "Define admin and support break-glass access boundaries before emergency access can become a customer-facing support or admin capability.",
  defaultPosture: "deny-by-default",
  leastPrivilegeRule:
    "Emergency access is limited to the narrowest access class, owner, TTL, audit event set, and revocation path that can resolve the approved incident.",
  maxTtlMinutes: 60,
  customerNotificationPosture:
    "Every approved session records a documented decision to notify, defer, or suppress customer notification with owner and redaction rationale.",
  revocationRule:
    "Revoke emergency access at TTL expiry, incident resolution, approval withdrawal, suspicious use, or customer/legal owner request.",
  roles: [
    {
      id: "support-operator",
      responsibility:
        "Requests customer-safe emergency access and records support context without self-approval authority.",
    },
    {
      id: "security-approver",
      responsibility:
        "Approves or denies access against least-privilege, redaction, and policy obligations.",
    },
    {
      id: "incident-commander",
      responsibility:
        "Approves incident-response access when customer impact or data safety is uncertain.",
    },
    {
      id: "customer-admin",
      responsibility:
        "Receives notification or approval handoff when the customer contract or impact path requires it.",
    },
  ],
  accessClasses: [
    {
      id: "tenant-data-inspection",
      owner: "Security Verification",
      purpose:
        "Read redacted tenant-scoped evidence needed to confirm customer impact or data-safety state.",
      approvalPath: ["security-approver"],
      auditEvents: REQUIRED_SESSION_EVENTS,
      maxTtlMinutes: 30,
      customerNotification:
        "Notify named customer admin after redaction unless security/legal records a deferral.",
      revocation: "Revoke when inspection facts are captured or the incident commander closes impact triage.",
    },
    {
      id: "support-debug-context",
      owner: "Support Workflow",
      purpose:
        "Read customer-safe logs, traces, project, entitlement, and environment context for support triage.",
      approvalPath: ["security-approver"],
      auditEvents: REQUIRED_SESSION_EVENTS,
      maxTtlMinutes: 60,
      customerNotification:
        "Record customer notification decision on the support ticket or incident record.",
      revocation: "Revoke at TTL expiry or when the support handoff has enough redacted evidence.",
    },
    {
      id: "billing-adjustment-review",
      owner: "Billing / Entitlements",
      purpose:
        "Review billing, entitlement, or rate-limit facts without applying financial changes in this boundary.",
      approvalPath: ["security-approver", "customer-admin"],
      auditEvents: REQUIRED_SESSION_EVENTS,
      maxTtlMinutes: 45,
      customerNotification:
        "Notify the customer admin before or at the same time as any billing-impacting support response.",
      revocation: "Revoke when the billing owner records the adjustment decision or routes a follow-up.",
    },
    {
      id: "policy-override-review",
      owner: "Security Verification",
      purpose:
        "Review a policy-denied admin/support action without bypassing Gatekeeper or policy evidence.",
      approvalPath: ["security-approver"],
      auditEvents: REQUIRED_SESSION_EVENTS,
      maxTtlMinutes: 30,
      customerNotification:
        "Record whether the policy override review is internal-only or customer-visible.",
      revocation: "Revoke on denial, approval expiry, or policy owner withdrawal.",
    },
    {
      id: "incident-response-emergency",
      owner: "Incident Communications / Operators SRE",
      purpose:
        "Coordinate emergency incident response evidence when impact is customer-visible or uncertain.",
      approvalPath: ["incident-commander", "security-approver"],
      auditEvents: REQUIRED_SESSION_EVENTS,
      maxTtlMinutes: 60,
      customerNotification:
        "Notify according to the incident communication owner and redaction state.",
      revocation: "Revoke when the incident commander records mitigation, handoff, or closure.",
    },
  ],
  unsupportedActions: [
    {
      id: "static-breakglass-account",
      reason: "Static emergency accounts are not allowed as a launch posture.",
    },
    {
      id: "self-approved-session",
      reason: "The requester cannot approve their own emergency access.",
    },
    {
      id: "raw-provider-credential-access",
      reason: "Provider credentials remain out of support/admin break-glass scope.",
    },
    {
      id: "silent-policy-bypass",
      reason: "Policy cannot be bypassed without a policy decision and audit fact.",
    },
    {
      id: "unbounded-live-data-mutation",
      reason: "Live customer-data mutation belongs to later owner-approved tooling, not this M0 boundary.",
    },
    {
      id: "indefinite-session",
      reason: "Emergency access requires a bounded TTL and revocation event.",
    },
    {
      id: "tooling-implementation",
      reason: "HOBO-495 defines the boundary; it does not build break-glass tooling.",
    },
  ],
  requiredAuditEvents: [
    "breakglass.requested",
    "breakglass.approved",
    "breakglass.started",
    "breakglass.used",
    "breakglass.revoked",
  ],
  dependencies: [
    {
      source: "docs/design/admin-console.md",
      reason: "Names admin-console visibility, action-intent, audit, and break-glass visibility boundaries.",
    },
    {
      source: "docs/design/member-rbac-administration.md",
      reason: "Defines role, approval, and no-self-escalation obligations.",
    },
    {
      source: "docs/design/support-sla-channels.md",
      reason: "Defines support handoff and unsupported request routing.",
    },
    {
      source: "docs/design/launch-support-escalation.md",
      reason: "Defines incident severity, communications ownership, and redaction prerequisites.",
    },
    {
      source: "docs/design/audit-explorer.md",
      reason: "Defines audit fact and export evidence shapes consumed by emergency access records.",
    },
    {
      source: "docs/design/security-verification.md",
      reason: "Defines launch-blocking security verification, embargo, and fix evidence boundaries.",
    },
  ],
  scopeOut: [
    "No break-glass tooling implementation in this issue.",
    "No static credentials, raw provider credential access, or production admin role creation.",
    "No unbounded live customer-data mutation.",
    "No silent Gatekeeper or policy bypass.",
    "No support ticketing, billing adjustment engine, incident automation, or Admin Console UI implementation.",
  ],
};

export function validateBreakGlassBoundaryContract(
  contract: BreakGlassBoundaryContract,
): ValidationResult {
  const errors: string[] = [];

  if (contract.issue !== "HOBO-495") {
    errors.push("issue must be HOBO-495");
  }

  if (contract.defaultPosture !== "deny-by-default") {
    errors.push("break-glass posture must be deny-by-default");
  }

  if (contract.maxTtlMinutes <= 0 || contract.maxTtlMinutes > 60) {
    errors.push("max TTL must be positive and no more than 60 minutes");
  }

  for (const accessClass of contract.accessClasses) {
    if (!accessClass.owner || accessClass.approvalPath.length === 0) {
      errors.push(`access class ${accessClass.id} must name owner and approval path`);
    }

    if (accessClass.maxTtlMinutes > contract.maxTtlMinutes) {
      errors.push(`access class ${accessClass.id} exceeds policy TTL`);
    }

    for (const eventId of REQUIRED_SESSION_EVENTS) {
      if (!accessClass.auditEvents.includes(eventId)) {
        errors.push(`access class ${accessClass.id} missing audit event ${eventId}`);
      }
    }
  }

  // SAFETY: `for (const eventId of [` is required at this I/O or test boundary.
  for (const eventId of [
    "breakglass.requested",
    "breakglass.approved",
    "breakglass.started",
    "breakglass.used",
    "breakglass.revoked",
  ] as BreakGlassEventId[]) {
    if (!contract.requiredAuditEvents.includes(eventId)) {
      errors.push(`required audit event ${eventId} missing`);
    }
  }

  if (!contract.customerNotificationPosture || !contract.revocationRule) {
    errors.push("customer notification posture and revocation rule are required");
  }

  const missingUnsupported = [
    "static-breakglass-account",
    "self-approved-session",
    "raw-provider-credential-access",
    "silent-policy-bypass",
    "unbounded-live-data-mutation",
    "indefinite-session",
    "tooling-implementation",
  ].filter(
    (id) => !contract.unsupportedActions.some((action) => action.id === id),
  );

  if (missingUnsupported.length > 0) {
    errors.push(`unsupported actions missing: ${missingUnsupported.join(", ")}`);
  }

  const scopeOutText = contract.scopeOut.join("\n");
  for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
    if (!pattern.test(scopeOutText)) {
      errors.push(`scope-out must explicitly reject ${pattern.source}`);
    }
  }

  return { errors };
}

export function evaluateBreakGlassSession(
  contract: BreakGlassBoundaryContract,
  request: BreakGlassSessionRequest,
): SessionDecision {
  if (
    contract.unsupportedActions.some((action) => action.id === request.accessClassId)
  ) {
    return { allowed: false, reason: "unsupported-emergency-action" };
  }

  const accessClass = contract.accessClasses.find(
    (candidate) => candidate.id === request.accessClassId,
  );

  if (!accessClass) {
    return { allowed: false, reason: "unknown-access-class" };
  }

  if (!request.approvedBy) {
    return { allowed: false, reason: "missing-approval" };
  }

  if (request.approvedBy === request.requestedBy) {
    return { allowed: false, reason: "self-approval-denied" };
  }

  if (!accessClass.approvalPath.includes(request.approvedBy)) {
    return { allowed: false, reason: "wrong-approver" };
  }

  const now = Date.parse(request.now);
  const expiresAt = Date.parse(request.expiresAt);
  const ttlMinutes = (expiresAt - now) / 60_000;

  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    return { allowed: false, reason: "expired-session" };
  }

  if (ttlMinutes > accessClass.maxTtlMinutes) {
    return { allowed: false, reason: "ttl-exceeds-policy" };
  }

  for (const eventId of REQUIRED_SESSION_EVENTS) {
    if (!request.auditEventIds.includes(eventId)) {
      return { allowed: false, reason: "missing-audit-event" };
    }
  }

  if (!request.customerNotificationDecision) {
    return { allowed: false, reason: "missing-customer-notification-decision" };
  }

  return { allowed: true, reason: "session-boundary-accepted" };
}

export function classifyBreakGlassRequest(requestText: string): ClassifiedRequest {
  const normalized = requestText.toLowerCase();

  if (/build|ui|tooling|screen/.test(normalized)) {
    return {
      owner: "Admin Console M1+ implementation",
      accessClassId: "tooling-implementation",
      inScope: false,
    };
  }

  if (/billing|invoice|entitlement|rate-limit|quota/.test(normalized)) {
    return {
      owner: "Billing / Entitlements",
      accessClassId: "billing-adjustment-review",
      inScope: true,
    };
  }

  if (/tenant data|customer data/.test(normalized)) {
    return {
      owner: "Security Verification",
      accessClassId: "tenant-data-inspection",
      inScope: true,
    };
  }

  if (/policy|override|gatekeeper/.test(normalized)) {
    return {
      owner: "Security Verification",
      accessClassId: "policy-override-review",
      inScope: true,
    };
  }

  if (/incident|sev|outage/.test(normalized)) {
    return {
      owner: "Incident Communications / Operators SRE",
      accessClassId: "incident-response-emergency",
      inScope: true,
    };
  }

  return {
    owner: "Support Workflow",
    accessClassId: "support-debug-context",
    inScope: true,
  };
}

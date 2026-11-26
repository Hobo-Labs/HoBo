export type AdminActionKind =
  | "propose-environment"
  | "approve-environment"
  | "revoke-environment"
  | "mutate-receipt"
  | string;

export type AdminActorRole = "broker-admin" | "security-reviewer" | "support-operator" | "platform-engineer";

export type BrokerAdminAction = Readonly<{
  kind: AdminActionKind;
  actorId: string;
  targetEnvironmentId: string;
  proposalId?: string;
  receiptId?: string;
  auditEvidenceId?: string;
  requestedChanges?: readonly string[];
  reviewerEvidenceIds?: readonly string[];
}>;

export type BrokerEnvironmentProposal = Readonly<{
  id: string;
  environmentId: string;
  proposedBy: string;
  requestedChanges: readonly string[];
  auditEvidenceIds: readonly string[];
  state: "pending";
}>;

export type BrokerEnvironmentSnapshot = Readonly<{
  id: string;
  version: number;
  sourceProposalId: string;
  approvedBy: string;
  auditEvidenceIds: readonly string[];
  state: "approved" | "revoked";
}>;

export type ResolutionReceiptRef = Readonly<{
  receiptId: string;
  environmentId: string;
  environmentVersion: number;
  digest: string;
  immutable: true;
}>;

export type BrokerAdminState = Readonly<{
  pendingProposals: readonly BrokerEnvironmentProposal[];
  environmentSnapshots: readonly BrokerEnvironmentSnapshot[];
  issuedReceiptRefs: readonly ResolutionReceiptRef[];
}>;

export type BrokerAdminEvent = Readonly<{
  type: "BrokerEnvironmentProposalRecorded" | "BrokerEnvironmentSnapshotApproved" | "BrokerEnvironmentSnapshotRevoked";
  actorId: string;
  targetEnvironmentId: string;
  auditEvidenceIds: readonly string[];
}>;

export type BrokerAdminResult =
  | Readonly<{
      accepted: true;
      event: BrokerAdminEvent;
      nextState: BrokerAdminState;
    }>
  | Readonly<{
      accepted: false;
      reason:
        | "unsupported-admin-action"
        | "actor-not-authorized-for-admin-approval"
        | "malformed-admin-action"
        | "proposal-not-found"
        | "proposal-environment-mismatch"
        | "self-approval-rejected"
        | "proposal-requires-audit-evidence"
        | "approval-requires-audit-evidence"
        | "revocation-requires-audit-evidence"
        | "environment-snapshot-not-found"
        | "admin-controls-cannot-mutate-issued-receipts";
      nextState: BrokerAdminState;
    }>;

export type OperatingBoundary = Readonly<{
  owner: "Admin Console" | "Meta-cloud Broker" | "Contracts, Policy & Governance" | "Support Workflow";
  rule: string;
}>;

export type BrokerAdminControlsContract = Readonly<{
  issue: "HOBO-527";
  phase: "M2";
  goal: string;
  scopeIn: readonly string[];
  scopeOut: readonly string[];
  acceptance: readonly string[];
  adversarial: readonly string[];
  operatingBoundaries: readonly OperatingBoundary[];
  designRefs: readonly string[];
  proofArtifacts: readonly string[];
}>;

export type MutableBrokerAdminControlsContract = Omit<
  BrokerAdminControlsContract,
  "scopeIn" | "scopeOut" | "acceptance" | "adversarial" | "operatingBoundaries" | "designRefs" | "proofArtifacts"
> & {
  scopeIn: string[];
  scopeOut: string[];
  acceptance: string[];
  adversarial: string[];
  operatingBoundaries: OperatingBoundary[];
  designRefs: string[];
  proofArtifacts: string[];
};

export type ValidationResult = Readonly<{
  ok: boolean;
  errors: readonly string[];
}>;

export type WorkClassification = Readonly<{
  owner: string;
  inScope: boolean;
}>;

const ADMIN_APPROVER_PATTERN = /^broker-admin-/;

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "admin console navigation",
    pattern: /\b(full admin console navigation|admin console navigation|react screens?|ui routes?|component implementation)\b/i,
  },
  {
    label: "hosted broker runtime",
    pattern: /\b(hosted broker runtime|broker runtime|runtime resolver|resolution service|live broker)\b/i,
  },
  {
    label: "receipt mutation",
    pattern: /\b(mutate issued receipt|edit receipt|rewrite receipt|overwrite receipt)\b/i,
  },
  {
    label: "Yard planner",
    pattern: /\b(Yard planner|DeploymentPlan|ResourcePlan|Matching engine)\b/i,
  },
]);

export const BROKER_ADMIN_CONTROLS_CONTRACT: BrokerAdminControlsContract = Object.freeze({
  issue: "HOBO-527",
  phase: "M2",
  goal:
    "Prove the minimum admin-control contract for broker environment proposals, approvals, revocations, audit evidence, and receipt immutability without building admin UI or hosted broker runtime.",
  scopeIn: Object.freeze([
    "Define broker environment proposal, approval, revocation, and audit evidence fixtures.",
    "Prove admin actions create new Broker Environment snapshots instead of mutating issued Resolution Receipts.",
    "Map support and security review boundaries for environment proposal and approval evidence.",
  ]),
  scopeOut: Object.freeze([
    "Do not build full admin console navigation, React screens, service persistence, or live approval workflows.",
    "Do not build hosted broker runtime, resolution service, signing service, or Yard planner behavior.",
    "Do not mutate issued Resolution Receipts or change Gatekeeper policy outcomes in place.",
  ]),
  acceptance: Object.freeze([
    "Admin proposal and approval fixtures produce auditable broker environment state transitions.",
    "Receipt mutation is impossible through admin controls.",
    "Unsupported or unauthorized admin actions fail closed.",
  ]),
  adversarial: Object.freeze([
    "Reject self-approval.",
    "Reject post-receipt mutation.",
    "Reject approval without audit evidence.",
  ]),
  operatingBoundaries: Object.freeze([
    {
      owner: "Admin Console",
      rule: "Owns future UX/admin surfaces and can propose environment input changes without executing broker resolution.",
    },
    {
      owner: "Meta-cloud Broker",
      rule: "Owns Broker Environment snapshots and Resolution Receipts; admin controls request new inputs, never mutate receipts.",
    },
    {
      owner: "Contracts, Policy & Governance",
      rule: "Owns security review and policy obligations that can block or annotate approvals without rewriting broker outcomes.",
    },
    {
      owner: "Support Workflow",
      rule: "Receives customer-safe proposal, approval, revocation, and rejection lineage for escalation and troubleshooting.",
    },
  ]),
  designRefs: Object.freeze([
    "Linear HOBO-527 issue body",
    "Linear HOBO-521 issue body",
    "docs/design/meta-cloud-broker.md",
    "docs/design/admin-console.md",
    "docs/design/capability-review-approval.md",
  ]),
  proofArtifacts: Object.freeze([
    "src/draft/technical-proofs/broker-admin-controls-contract/src/broker-admin-controls.ts",
    "src/draft/technical-proofs/broker-admin-controls-contract/test/broker-admin-controls.test.ts",
    "src/draft/technical-proofs/broker-admin-controls-contract/architecture/broker_admin_controls.proto",
    "src/draft/technical-proofs/broker-admin-controls-contract/architecture/broker_admin_controls.cue",
    "src/draft/technical-proofs/broker-admin-controls-contract/architecture/pacts/broker_admin_controls.pact.json",
  ]),
});

export function createInitialBrokerAdminState(seed: Partial<BrokerAdminState> = {}): BrokerAdminState {
  return Object.freeze({
    pendingProposals: Object.freeze([...(seed.pendingProposals ?? [])]),
    environmentSnapshots: Object.freeze([...(seed.environmentSnapshots ?? [])]),
    issuedReceiptRefs: Object.freeze([...(seed.issuedReceiptRefs ?? [])]),
  });
}

export function applyBrokerAdminAction(state: BrokerAdminState, action: BrokerAdminAction): BrokerAdminResult {
  const actorId = parseRequiredId(action.actorId);
  const targetEnvironmentId = parseRequiredId(action.targetEnvironmentId);
  if (!actorId || !targetEnvironmentId) {
    return fail("malformed-admin-action", state);
  }

  if (action.kind === "mutate-receipt") {
    return fail("admin-controls-cannot-mutate-issued-receipts", state);
  }

  if (action.kind === "propose-environment") {
    const auditEvidenceId = parseEvidenceId(action.auditEvidenceId);
    if (!auditEvidenceId) {
      return fail("proposal-requires-audit-evidence", state);
    }
    const proposalId = parseRequiredId(action.proposalId);
    if (!proposalId) {
      return fail("malformed-admin-action", state);
    }

    const proposal: BrokerEnvironmentProposal = Object.freeze({
      id: proposalId,
      environmentId: targetEnvironmentId,
      proposedBy: actorId,
      requestedChanges: Object.freeze([...(action.requestedChanges ?? [])]),
      auditEvidenceIds: Object.freeze([auditEvidenceId]),
      state: "pending",
    });

    const nextState = createInitialBrokerAdminState({
      ...state,
      pendingProposals: [...state.pendingProposals, proposal],
    });

    return {
      accepted: true,
      event: {
        type: "BrokerEnvironmentProposalRecorded",
        actorId,
        targetEnvironmentId,
        auditEvidenceIds: proposal.auditEvidenceIds,
      },
      nextState,
    };
  }

  if (action.kind === "approve-environment") {
    if (!ADMIN_APPROVER_PATTERN.test(actorId)) {
      return fail("actor-not-authorized-for-admin-approval", state);
    }

    const proposalId = parseRequiredId(action.proposalId);
    if (!proposalId) {
      return fail("malformed-admin-action", state);
    }
    const proposal = state.pendingProposals.find((candidate) => candidate.id === proposalId);
    if (!proposal) {
      return fail("proposal-not-found", state);
    }
    if (proposal.environmentId !== targetEnvironmentId) {
      return fail("proposal-environment-mismatch", state);
    }
    if (proposal.proposedBy === actorId) {
      return fail("self-approval-rejected", state);
    }

    const auditEvidence = compactEvidence([
      action.auditEvidenceId,
      ...(action.reviewerEvidenceIds ?? []),
    ]);
    if (auditEvidence.length === 0) {
      return fail("approval-requires-audit-evidence", state);
    }

    const priorVersion = state.environmentSnapshots
      .filter((snapshot) => snapshot.id === targetEnvironmentId)
      .reduce((version, snapshot) => Math.max(version, snapshot.version), 0);

    const snapshot: BrokerEnvironmentSnapshot = Object.freeze({
      id: targetEnvironmentId,
      version: priorVersion + 1,
      sourceProposalId: proposal.id,
      approvedBy: actorId,
      auditEvidenceIds: Object.freeze([...proposal.auditEvidenceIds, ...auditEvidence]),
      state: "approved",
    });

    const nextState = createInitialBrokerAdminState({
      pendingProposals: state.pendingProposals.filter((candidate) => candidate.id !== proposal.id),
      environmentSnapshots: [...state.environmentSnapshots, snapshot],
      issuedReceiptRefs: state.issuedReceiptRefs,
    });

    return {
      accepted: true,
      event: {
        type: "BrokerEnvironmentSnapshotApproved",
        actorId,
        targetEnvironmentId,
        auditEvidenceIds: snapshot.auditEvidenceIds,
      },
      nextState,
    };
  }

  if (action.kind === "revoke-environment") {
    if (!ADMIN_APPROVER_PATTERN.test(actorId)) {
      return fail("actor-not-authorized-for-admin-approval", state);
    }

    const currentSnapshot = [...state.environmentSnapshots]
      .reverse()
      .find((snapshot) => snapshot.id === targetEnvironmentId);
    if (!currentSnapshot) {
      return fail("environment-snapshot-not-found", state);
    }

    const auditEvidence = compactEvidence([
      action.auditEvidenceId,
      ...(action.reviewerEvidenceIds ?? []),
    ]);
    if (auditEvidence.length === 0) {
      return fail("revocation-requires-audit-evidence", state);
    }

    const snapshot: BrokerEnvironmentSnapshot = Object.freeze({
      id: targetEnvironmentId,
      version: currentSnapshot.version + 1,
      sourceProposalId: currentSnapshot.sourceProposalId,
      approvedBy: actorId,
      auditEvidenceIds: auditEvidence,
      state: "revoked",
    });

    const nextState = createInitialBrokerAdminState({
      pendingProposals: state.pendingProposals,
      environmentSnapshots: [...state.environmentSnapshots, snapshot],
      issuedReceiptRefs: state.issuedReceiptRefs,
    });

    return {
      accepted: true,
      event: {
        type: "BrokerEnvironmentSnapshotRevoked",
        actorId,
        targetEnvironmentId,
        auditEvidenceIds: snapshot.auditEvidenceIds,
      },
      nextState,
    };
  }

  return fail("unsupported-admin-action", state);
}

export function validateBrokerAdminControlsContract(
  contract: Partial<MutableBrokerAdminControlsContract>,
): ValidationResult {
  const errors: string[] = [];

  if (contract.issue !== "HOBO-527") {
    errors.push("contract issue must be HOBO-527");
  }
  if (contract.phase !== "M2") {
    errors.push("contract phase must be M2");
  }
  if (!contract.goal?.toLowerCase().includes("admin-control")) {
    errors.push("goal must name admin-control contract");
  }

  for (const expected of BROKER_ADMIN_CONTROLS_CONTRACT.acceptance) {
    if (!contract.acceptance?.includes(expected)) {
      errors.push(`missing acceptance: ${expected}`);
    }
  }

  for (const expected of BROKER_ADMIN_CONTROLS_CONTRACT.adversarial) {
    if (!contract.adversarial?.includes(expected)) {
      errors.push(`missing adversarial guard: ${expected}`);
    }
  }

  const owners = new Set(contract.operatingBoundaries?.map((boundary) => boundary.owner) ?? []);
  for (const owner of ["Admin Console", "Meta-cloud Broker", "Contracts, Policy & Governance", "Support Workflow"]) {
    // SAFETY: assertion to `if (!owners.has(owner as OperatingBoundary["owner"])) {` is required at this boundary.
    if (!owners.has(owner as OperatingBoundary["owner"])) {
      errors.push(`missing operating boundary owner: ${owner}`);
    }
  }

  for (const scopeItem of contract.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(scopeItem)) {
        errors.push(`scope creep rejected: ${label}`);
      }
    }
  }

  for (const artifact of BROKER_ADMIN_CONTROLS_CONTRACT.proofArtifacts) {
    if (!contract.proofArtifacts?.includes(artifact)) {
      errors.push(`missing proof artifact: ${artifact}`);
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

export function mutableBrokerAdminControlsContract(): MutableBrokerAdminControlsContract {
  return {
    ...BROKER_ADMIN_CONTROLS_CONTRACT,
    scopeIn: [...BROKER_ADMIN_CONTROLS_CONTRACT.scopeIn],
    scopeOut: [...BROKER_ADMIN_CONTROLS_CONTRACT.scopeOut],
    acceptance: [...BROKER_ADMIN_CONTROLS_CONTRACT.acceptance],
    adversarial: [...BROKER_ADMIN_CONTROLS_CONTRACT.adversarial],
    operatingBoundaries: [...BROKER_ADMIN_CONTROLS_CONTRACT.operatingBoundaries],
    designRefs: [...BROKER_ADMIN_CONTROLS_CONTRACT.designRefs],
    proofArtifacts: [...BROKER_ADMIN_CONTROLS_CONTRACT.proofArtifacts],
  };
}

export function classifyBrokerAdminControlWork(description: string): WorkClassification {
  const normalized = description.toLowerCase();

  if (/\b(admin console navigation|react screen|route|component|settings page)\b/.test(normalized)) {
    return { owner: "Admin Console", inScope: false };
  }
  if (/\b(hosted broker runtime|runtime resolver|resolution service|live broker)\b/.test(normalized)) {
    return { owner: "Meta-cloud Broker Runtime", inScope: false };
  }
  if (/\b(yard planner|deploymentplan|resourceplan|matching engine)\b/.test(normalized)) {
    return { owner: "Control Plane: Planner, Matching & Orchestrator", inScope: false };
  }
  if (/\b(gatekeeper|policy engine|mandatory policy)\b/.test(normalized)) {
    return { owner: "Contracts, Policy & Governance", inScope: false };
  }

  return { owner: "Broker Admin Controls Contract", inScope: true };
}

function compactEvidence(values: readonly (string | undefined)[]): readonly string[] {
  return Object.freeze(values.map((value) => value?.trim() ?? "").filter(Boolean));
}

function parseEvidenceId(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function parseRequiredId(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function fail(reason: Extract<BrokerAdminResult, { accepted: false }>["reason"], state: BrokerAdminState): BrokerAdminResult {
  return {
    accepted: false,
    reason,
    nextState: state,
  };
}

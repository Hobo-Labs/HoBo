export const REQUIRED_PROOF_SURFACES = [
  "onboarding",
  "plan-diff",
  "deployment-status-topology",
  "safe-tests",
  "cost-approval-gates",
  "telemetry",
  "support",
  "docs",
];

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

export const outcomeActivationRail = {
  issue: "HOBO-508",
  project: "Workspace & Onboarding UX",
  phase: "M0",
  goal:
    "Define the v1 activation rail that carries a user from outcome statement through safe proof, plan review, launch, monitoring, and value evidence without creating a second product shell.",
  stages: [
    {
      id: "outcome-capture",
      label: "Outcome capture",
      entryCriteria: ["User has workspace access or an anonymous try-it path."],
      exitCriteria: ["Plain-language desired outcome and persona label are recorded."],
      personaLabels: ["non-expert buyer/user", "app developer evaluator"],
      evidenceObjects: ["activation.outcome", "workspace.profile"],
      handoffProjects: ["Workspace & Onboarding UX", "Customer Onboarding"],
    },
    {
      id: "safe-test-selection",
      label: "Safe test selection",
      entryCriteria: ["Outcome is classified by risk, persona, and supported template path."],
      exitCriteria: ["Safe-test fixture and proof mode are selected before any live launch claim."],
      personaLabels: ["non-expert buyer/user", "security reviewer"],
      evidenceObjects: ["safe-test.fixture", "proof-mode.declaration"],
      handoffProjects: ["Example Apps", "Security Verification"],
    },
    {
      id: "plan-review",
      label: "Plan review",
      entryCriteria: ["A collected manifest or accepted fixture exists."],
      exitCriteria: ["Plan/diff, topology, cost, warnings, and approval requirements are visible."],
      personaLabels: ["technical operator", "platform engineer"],
      evidenceObjects: ["deployment.plan", "topology.summary", "approval.requirement"],
      handoffProjects: ["Plan/Diff Viewer", "Deployment Dashboard & Topology Explorer"],
    },
    {
      id: "launch-with-guardrails",
      label: "Launch with guardrails",
      entryCriteria: ["Plan review has no launch-blocking unknowns or unapproved risky actions."],
      exitCriteria: ["Launch status, rollback path, and policy/cost gate outcomes are captured."],
      personaLabels: ["technical operator", "support/operator"],
      evidenceObjects: ["deployment.status", "policy.decision", "cost.guardrail"],
      handoffProjects: ["Deployment Dashboard & Topology Explorer", "Support & Debug Tools"],
    },
    {
      id: "value-proof",
      label: "Value proof",
      entryCriteria: ["A launched or simulated outcome has telemetry and support-visible evidence."],
      exitCriteria: ["User-facing value proof, operator evidence, docs link, and follow-up owner are recorded."],
      personaLabels: ["non-expert buyer/user", "technical operator", "customer/buyer"],
      evidenceObjects: ["activation.value-proof", "telemetry.summary", "docs.handoff"],
      handoffProjects: ["Workspace & Onboarding UX", "Launch Documentation", "Support Workflow"],
    },
  ],
  proofSurfaces: [
    {
      id: "onboarding",
      sourceProject: "Workspace & Onboarding UX",
      existingCapability: "Workspace creation, persona labels, first-run profile, and activation events.",
    },
    {
      id: "plan-diff",
      sourceProject: "Plan/Diff Viewer",
      existingCapability: "DeploymentPlan, topology/cost diff, warnings, and approval obligations.",
    },
    {
      id: "deployment-status-topology",
      sourceProject: "Deployment Dashboard & Topology Explorer",
      existingCapability: "Deployment status, topology view, rollout state, and recovery visibility.",
    },
    {
      id: "safe-tests",
      sourceProject: "Example Apps",
      existingCapability: "Safe fixtures, proof modes, and example command paths before public claims.",
    },
    {
      id: "cost-approval-gates",
      sourceProject: "Contracts/Policy/FinOps",
      existingCapability: "Cost caps, policy decisions, approvals, and can-deploy gate outcomes.",
    },
    {
      id: "telemetry",
      sourceProject: "Workspace & Onboarding UX",
      existingCapability: "Activation funnel, first-run telemetry, and value-evidence events.",
    },
    {
      id: "support",
      sourceProject: "Support Workflow",
      existingCapability: "Support/debug handoff, escalation route, unsupported state classification.",
    },
    {
      id: "docs",
      sourceProject: "V1 Release Notes & Upgrade Guide",
      existingCapability: "Known limitations, getting-started path, release-note and support links.",
    },
  ],
  audienceViews: [
    {
      audience: "non-expert buyer/user",
      visibleSignals: [
        "plain-language outcome",
        "safe test selected",
        "ready/blocked launch state",
        "value proof summary",
      ],
      hiddenSignals: [
        "raw topology graph",
        "provider-specific plan internals",
        "policy rule expression",
        "internal support routing",
      ],
    },
    {
      audience: "technical operator",
      visibleSignals: [
        "plan diff",
        "topology summary",
        "approval gates",
        "telemetry facts",
        "evidence object ids",
      ],
      hiddenSignals: [
        "marketing copy",
        "buyer-only simplifications",
      ],
    },
  ],
  scopeBoundary: {
    kind: "ux-orchestration-layer",
    buildsNewWorkflowEngine: false,
    buildsDuplicateProductShell: false,
    statement:
      "The rail composes existing onboarding, plan, dashboard, safe-test, policy, telemetry, support, and docs surfaces; it does not implement a workflow engine, product shell, or new runtime path.",
  },
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "Do not create M1-M4 implementation issues until the activation rail record is accepted and owner handoffs are approved.",
  },
};

export function canCreateOutcomeActivationFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function validateOutcomeActivationRail(record) {
  const errors = [];

  if (!isPlainObject(record)) {
    return { ok: false, errors: ["outcome activation rail record is required"] };
  }
  if (record.issue !== "HOBO-508") {
    errors.push("issue must be HOBO-508");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!record.goal?.toLowerCase().includes("activation rail")) {
    errors.push("goal must name the activation rail");
  }

  for (const stage of record.stages ?? []) {
    for (const field of ["entryCriteria", "exitCriteria", "personaLabels", "evidenceObjects", "handoffProjects"]) {
      if (!Array.isArray(stage[field]) || stage[field].length === 0) {
        errors.push(`${stage.id ?? "<unknown stage>"} missing ${field === "evidenceObjects" ? "evidence" : field}`);
      }
    }
  }
  if ((record.stages ?? []).length < 5) {
    errors.push("activation rail must define at least five stages");
  }

  const surfaces = new Set((record.proofSurfaces ?? []).map((surface) => surface.id));
  for (const surface of REQUIRED_PROOF_SURFACES) {
    if (!surfaces.has(surface)) {
      errors.push(`missing proof surface: ${surface}`);
    }
  }
  for (const surface of record.proofSurfaces ?? []) {
    if (!surface.sourceProject || !surface.existingCapability) {
      errors.push(`${surface.id ?? "<unknown surface>"} must name source project and existing capability`);
    }
  }

  if (record.scopeBoundary?.buildsNewWorkflowEngine) {
    errors.push("new workflow engine is scope-out");
  }
  if (record.scopeBoundary?.buildsDuplicateProductShell) {
    errors.push("duplicate product shell is scope-out");
  }
  if (record.scopeBoundary?.kind !== "ux-orchestration-layer") {
    errors.push("scope boundary must classify the rail as a UX orchestration layer");
  }

  const audiences = (record.audienceViews ?? []).map((view) => view.audience);
  for (const requiredAudience of ["non-expert buyer/user", "technical operator"]) {
    if (!audiences.includes(requiredAudience)) {
      errors.push(`missing audience view: ${requiredAudience}`);
    }
  }

  if (!record.followUpGate?.allowedAfter || !record.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return { ok: errors.length === 0, errors };
}

function isPlainObject(value) {
  return value != null && Object.prototype.toString.call(value) === "[object Object]";
}

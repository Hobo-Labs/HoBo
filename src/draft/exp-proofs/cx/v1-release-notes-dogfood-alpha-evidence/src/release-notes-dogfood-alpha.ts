import { isJsonObject } from "./json.js";
const REQUIRED_EVIDENCE_IDS = [
  "release-summary-dogfood-cutline",
  "supported-install-alpha-smoke",
  "upgrade-dry-run-alpha",
  "compatibility-alpha-thresholds",
  "known-limitations-alpha-register",
  "support-contact-alpha-route",
];

const REQUIRED_CUTLINE_CATEGORIES = [
  "v1-blocker.documentation",
  "v1-blocker.operations-readiness",
  "v1-blocker.productization",
  "v1-blocker.support",
];

const ACCEPTED_STATUSES = new Set(["accepted", "accepted-with-risk"]);

export const RELEASE_NOTES_DOGFOOD_ALPHA_GATE = {
  schema: "hobo.v1.release-notes-dogfood-alpha/2026-06-30",
  issue: "HOBO-459",
  project: "V1 Release Notes & Upgrade Guide",
  phase: "M1",
  milestone: "M1 Dogfood/alpha proof",
  upstreamContracts: [
    {
      issue: "HOBO-407",
      proofPackage: "v1-release-notes-upgrade-guide-contract",
      role: "M0 outline and missing-evidence policy",
    },
    {
      issue: "HOBO-401",
      proofPackage: "v1-cutline-contract",
      role: "v1 release cutline blocker-category source",
    },
  ],
  evidence: [
    {
      id: "release-summary-dogfood-cutline",
      ownerProject: "V1 Release Program & Cutline",
      sourceEvidence: "Dogfood/alpha release-cutline snapshot",
      releaseNoteSections: ["release-summary"],
      cutlineCategory: "v1-blocker.documentation",
      status: "accepted",
    },
    {
      id: "supported-install-alpha-smoke",
      ownerProject: "Bootstrap Installer",
      sourceEvidence: "SaaS, self-host, and local/dev alpha smoke matrix",
      releaseNoteSections: ["supported-install-paths", "support-contacts"],
      cutlineCategory: "v1-blocker.productization",
      status: "accepted",
    },
    {
      id: "upgrade-dry-run-alpha",
      ownerProject: "Upgrade & Migration Engine",
      sourceEvidence: "Dogfood upgrade dry-run transcript with rollback decision",
      releaseNoteSections: ["upgrade-paths", "rollback-guidance", "migration-notes"],
      cutlineCategory: "v1-blocker.operations-readiness",
      status: "accepted-with-risk",
    },
    {
      id: "compatibility-alpha-thresholds",
      ownerProject: "Compatibility Matrix",
      sourceEvidence: "Alpha browser, device, CLI, and bootstrap threshold snapshot",
      releaseNoteSections: ["compatibility-matrix", "migration-notes"],
      cutlineCategory: "v1-blocker.productization",
      status: "accepted",
    },
    {
      id: "known-limitations-alpha-register",
      ownerProject: "V1 Docs",
      sourceEvidence: "Dogfood-only known-limitations register and owner map",
      releaseNoteSections: ["known-limitations", "release-summary"],
      cutlineCategory: "v1-blocker.documentation",
      status: "accepted-with-risk",
    },
    {
      id: "support-contact-alpha-route",
      ownerProject: "V1 Launch Support Desk & Escalation",
      sourceEvidence: "Dogfood support channel, severity route, and escalation owner",
      releaseNoteSections: ["support-contacts", "rollback-guidance"],
      cutlineCategory: "v1-blocker.support",
      status: "accepted",
    },
  ],
  blockers: [
    {
      id: "known-limitations-copy-owner-approval",
      ownerProject: "V1 Docs",
      state: "accepted-risk",
      acceptedRiskId: "dogfood-only-upgrade-copy",
      mitigation: "Customer-facing copy stays dogfood-only until release-candidate evidence is accepted.",
    },
  ],
  acceptedRisks: [
    {
      id: "dogfood-only-upgrade-copy",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      launchImpact: "Dogfood/alpha release notes may describe upgrade dry-run evidence, not production upgrade support.",
      mitigation: "Release-candidate notes must replace this copy with accepted upgrade evidence or a launch limitation.",
    },
  ],
  followUps: [],
  launchRiskChanged: true,
  parentReadinessStatusUpdate: {
    initiative: "HoBo v1 Release Readiness",
    status: "at-risk",
    reason: "Accepted dogfood-only upgrade copy risk changes launch-note posture.",
  },
};

export function deriveDogfoodAlphaFollowUps(record = RELEASE_NOTES_DOGFOOD_ALPHA_GATE) {
  return (record.followUps ?? []).map((followUp) => followUp.evidenceId);
}

export function evaluateDogfoodAlphaGate(record = RELEASE_NOTES_DOGFOOD_ALPHA_GATE) {
  const result = validateDogfoodAlphaGate(record);
  const evidence = record.evidence ?? [];

  let acceptanceState = "accepted";
  if (!result.ok) {
    acceptanceState = "rejected";
  } else if (evidence.some((item) => item.status === "missing")) {
    acceptanceState = "blocked";
  } else if (
    evidence.some((item) => item.status === "accepted-with-risk") ||
    (record.acceptedRisks ?? []).length > 0 ||
    (record.blockers ?? []).some((blocker) => blocker.state === "accepted-risk")
  ) {
    acceptanceState = "accepted-with-risk";
  }

  return {
    acceptanceState,
    parentReadinessStatusUpdate: record.launchRiskChanged ? record.parentReadinessStatusUpdate : null,
  };
}

export function validateDogfoodAlphaGate(record) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["dogfood alpha gate record is required"] };
  }

  if (record.issue !== "HOBO-459") {
    errors.push("issue must be HOBO-459");
  }
  if (record.phase !== "M1") {
    errors.push("phase must be M1");
  }
  if (!/dogfood\/alpha/i.test(record.milestone ?? "")) {
    errors.push("milestone must be M1 Dogfood/alpha proof");
  }

  const evidence = record.evidence ?? [];
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  for (const id of REQUIRED_EVIDENCE_IDS) {
    if (!evidenceById.has(id)) {
      errors.push(`missing M1 evidence: ${id}`);
    }
  }

  const categorySet = new Set();
  for (const item of evidence) {
    if (!item.ownerProject || !item.sourceEvidence) {
      errors.push(`${item.id ?? "<missing>"} must name ownerProject and sourceEvidence`);
    }
    if (!Array.isArray(item.releaseNoteSections) || item.releaseNoteSections.length === 0) {
      errors.push(`${item.id ?? "<missing>"} must map to release-note sections`);
    }
    if (!item.cutlineCategory?.startsWith("v1-blocker.")) {
      errors.push(`${item.id ?? "<missing>"} must map to a v1 cutline blocker category`);
    } else {
      categorySet.add(item.cutlineCategory);
    }
    if (item.status !== "missing" && !ACCEPTED_STATUSES.has(item.status)) {
      errors.push(`${item.id ?? "<missing>"} has unsupported evidence status`);
    }
  }

  for (const category of REQUIRED_CUTLINE_CATEGORIES) {
    if (!categorySet.has(category)) {
      errors.push(`missing cutline category: ${category}`);
    }
  }

  for (const blocker of record.blockers ?? []) {
    if (!blocker.id || !blocker.ownerProject || !blocker.state) {
      errors.push("blockers must name id, ownerProject, and state");
    }
    if (blocker.state === "accepted-risk" && !blocker.acceptedRiskId) {
      errors.push(`${blocker.id}: accepted-risk blockers must link to acceptedRiskId`);
    }
  }

  for (const risk of record.acceptedRisks ?? []) {
    if (!risk.id || !risk.ownerProject || !risk.launchImpact || !risk.mitigation) {
      errors.push("accepted risks must name id, ownerProject, launchImpact, and mitigation");
    }
  }

  const missingEvidence = new Set(evidence.filter((item) => item.status === "missing").map((item) => item.id));
  const followUpEvidence = new Set();
  for (const followUp of record.followUps ?? []) {
    followUpEvidence.add(followUp.evidenceId);
    if (!missingEvidence.has(followUp.evidenceId)) {
      errors.push(`follow-up ${followUp.evidenceId} has no missing evidence`);
    }
    if (!followUp.issue || !followUp.ownerProject || !followUp.reason) {
      errors.push(`follow-up ${followUp.evidenceId ?? "<missing>"} must name issue, ownerProject, and reason`);
    }
  }
  for (const evidenceId of missingEvidence) {
    if (!followUpEvidence.has(evidenceId)) {
      errors.push(`missing evidence ${evidenceId} must have a follow-up issue`);
    }
  }

  if (record.launchRiskChanged) {
    const update = record.parentReadinessStatusUpdate;
    if (!update?.initiative || !update.status || !update.reason) {
      errors.push("parent release-readiness status update is required when launch risk changes");
    }
  }

  return { ok: errors.length === 0, errors };
}

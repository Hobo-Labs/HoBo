import { isJsonObject } from "./json.js";
const REQUIRED_DEMO_ASSETS = new Set([
  "claim-index",
  "demo-script",
  "command-transcript",
  "screenshot-set",
  "recording-manifest"
]);

const VALID_PROOF_MODES = new Set(["design-record", "manual-review", "reference-fixture", "live-recording"]);

type EvidenceStatus = "accepted" | "missing" | "pending";

export type LaunchEvidenceItem = {
  id: string;
  ownerProject: string;
  evidenceSource: string;
  proves: string;
  status: EvidenceStatus;
};

export type LaunchDemoAsset = {
  kind: string;
  ownerProject: string;
  proofMode: string;
  refreshTrigger: string;
  sourceEvidenceId: string;
  privateBetaOnly: boolean;
};

export type LaunchFollowUpIssue = {
  id: string;
  ownerProject: string;
  missingEvidenceId: string;
  allowedReason: string;
};

export type LaunchBlocker = {
  id: string;
  category: string;
  ownerProject: string;
  sourceEvidenceId: string;
  disposition: string;
};

export type LaunchAcceptedRisk = {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchNote: string;
};

export type LaunchCrossProjectDependency = {
  ownerProject: string;
  dependency: string;
};

export type LaunchMissingEvidence = {
  id: string;
  ownerProject: string;
  reason: string;
};

export const launchSitePrivateBetaEvidence = {
  schema: "hobo.launch-site.private-beta-evidence/2026-06-30",
  issue: "HOBO-465",
  parentIssue: "HOBO-406",
  project: "V1 Launch Site, Messaging & Demo Assets",
  phase: "M2",
  milestoneGate: "M2 Private beta proof",
  decisionStatus: "private-beta-evidence-accepted",
  requiredEvidence: [
    {
      id: "claim-register",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      evidenceSource: "docs/design/launch-messaging-claims.md",
      proves: "Launch claims retain evidence owner, evidence source, risk, state, and disposition before private beta publication.",
      status: "accepted"
    },
    {
      id: "golden-path-demo",
      ownerProject: "Example Apps",
      evidenceSource: "docs/design/launch-demo-golden-path.md",
      proves: "Snapshop demo command path and proof modes are available for private beta launch assets.",
      status: "accepted"
    },
    {
      id: "launch-asset-manifest",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      evidenceSource: "src/draft/exp-proofs/cx/launch-site-private-beta-evidence-contract",
      proves: "Claim index, demo script, transcript, screenshots, and recording manifest have owners and refresh triggers.",
      status: "accepted"
    },
    {
      id: "private-beta-cutline",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "src/draft/technical-proofs/v1-cutline-contract/README.md",
      proves: "Private beta messaging routes launch risk through the release cutline instead of promoting GA claims.",
      status: "accepted"
    },
    {
      id: "legal-support-handoff",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      evidenceSource: "docs/design/legal-privacy-terms-readiness.md",
      proves: "Customer-facing communications align with legal/privacy, support, limitations, and release owner boundaries.",
      status: "accepted"
    }
  ] satisfies LaunchEvidenceItem[],
  demoAssets: [
    {
      kind: "claim-index",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      proofMode: "design-record",
      refreshTrigger: "Any claim state, owner, risk, evidence source, or disposition changes.",
      sourceEvidenceId: "claim-register",
      privateBetaOnly: true
    },
    {
      kind: "demo-script",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      proofMode: "manual-review",
      refreshTrigger: "Golden path, persona, unsupported state, or claim boundary wording changes.",
      sourceEvidenceId: "golden-path-demo",
      privateBetaOnly: true
    },
    {
      kind: "command-transcript",
      ownerProject: "Example Apps",
      proofMode: "reference-fixture",
      refreshTrigger: "Command path, CLI wording, fixture output, or sample-app behavior changes.",
      sourceEvidenceId: "golden-path-demo",
      privateBetaOnly: true
    },
    {
      kind: "screenshot-set",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      proofMode: "live-recording",
      refreshTrigger: "Private beta UI surface, proof-mode label, or expected output changes.",
      sourceEvidenceId: "launch-asset-manifest",
      privateBetaOnly: true
    },
    {
      kind: "recording-manifest",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      proofMode: "live-recording",
      refreshTrigger: "Live preview recording, simulated/reference marker, or asset freshness changes.",
      sourceEvidenceId: "launch-asset-manifest",
      privateBetaOnly: true
    }
  ] satisfies LaunchDemoAsset[],
  blockers: [
    {
      id: "public-ga-claims-blocked",
      category: "launch-claim",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      sourceEvidenceId: "private-beta-cutline",
      disposition: "Private beta messaging may be used internally; public or GA wording waits for RC/GA evidence."
    },
    {
      id: "live-recording-freshness-blocked",
      category: "demo-asset",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      sourceEvidenceId: "launch-asset-manifest",
      disposition: "Stale screenshots or recordings block private beta demo use until refreshed or downgraded."
    }
  ] satisfies LaunchBlocker[],
  acceptedRisks: [
    {
      id: "reference-fixture-demo-risk",
      ownerProject: "Example Apps",
      mitigation: "Reference fixture and simulated-reference modes stay visibly labeled.",
      launchNote: "Private beta demos distinguish live product behavior from fixture evidence."
    },
    {
      id: "legal-copy-drift-risk",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      mitigation: "Customer-facing copy routes through legal/privacy readiness before public promotion.",
      launchNote: "Private beta wording stays constrained to evidence-backed claims."
    }
  ] satisfies LaunchAcceptedRisk[],
  crossProjectDependencies: [
    {
      ownerProject: "V1 Release Program & Cutline",
      dependency: "Launch-risk changes must update the parent release readiness initiative."
    },
    {
      ownerProject: "Example Apps",
      dependency: "Golden-path command transcript and fixture outputs remain source evidence for demo assets."
    },
    {
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      dependency: "Customer-facing claims require legal/privacy and terms posture before wider publication."
    },
    {
      ownerProject: "V1 Launch Support Desk & Escalation",
      dependency: "Support handoff language and unsupported-state routing must be reflected in private beta demo notes."
    }
  ] satisfies LaunchCrossProjectDependency[],
  missingEvidence: [
    {
      id: "public-copy-approval",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      reason: "Public launch copy is outside private beta and needs later RC/GA evidence."
    },
    {
      id: "ga-live-recording",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      reason: "GA recording freshness is not proven by a private beta evidence gate."
    }
  ] satisfies LaunchMissingEvidence[],
  followUpIssues: [
    {
      id: "follow-up-public-copy-approval",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      missingEvidenceId: "public-copy-approval",
      allowedReason: "Public-copy approval is missing and belongs to a later release-candidate or GA gate."
    },
    {
      id: "follow-up-ga-live-recording",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      missingEvidenceId: "ga-live-recording",
      allowedReason: "GA live recording is missing and cannot be inferred from private beta assets."
    }
  ] satisfies LaunchFollowUpIssue[],
  publicationGate: {
    privateBetaPublicationAllowed: true,
    publicOrGaPromotionAllowed: false,
    requiredLabel: "private-beta-only",
    refusal: "Private beta evidence cannot promote public, release-candidate, or GA launch claims."
  },
  parentInitiativeSync: {
    launchRiskChanged: true,
    statusUpdated: true,
    update: "Private beta launch messaging evidence accepted; public and GA claim promotion remains blocked."
  },
  scopeOut: [
    "Do not build the launch marketing site, public page, or final visual assets.",
    "Do not publish final launch copy or customer-facing production-readiness claims.",
    "Do not promote private beta evidence to release-candidate or GA evidence.",
    "Do not create follow-up issues for accepted evidence."
  ]
};

export function validateLaunchSitePrivateBetaEvidence(record: typeof launchSitePrivateBetaEvidence) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch site private beta evidence is required"] };
  }
  if (record.issue !== "HOBO-465") errors.push("issue must be HOBO-465");
  if (record.phase !== "M2") errors.push("phase must be M2");
  if (record.project !== "V1 Launch Site, Messaging & Demo Assets") {
    errors.push("project must be V1 Launch Site, Messaging & Demo Assets");
  }

  const missingEvidenceIds = new Set((record.missingEvidence ?? []).map((item) => item.id));
  const acceptedEvidenceIds = new Set(
    (record.requiredEvidence ?? []).filter((item) => item.status === "accepted").map((item) => item.id)
  );

  for (const item of record.requiredEvidence ?? []) {
    if (!item.ownerProject || !item.evidenceSource || !item.proves) {
      errors.push("required evidence requires owner project, source, and proof statement");
    }
    if (item.status !== "accepted") {
      errors.push(`${item.id} must be accepted`);
    }
  }

  if (!Array.isArray(record.blockers) || record.blockers.length < 2) {
    errors.push("blockers must be recorded");
  }
  for (const blocker of record.blockers ?? []) {
    if (!blocker.id || !blocker.category || !blocker.ownerProject || !blocker.sourceEvidenceId || !blocker.disposition) {
      errors.push("blockers require id, category, owner project, source evidence, and disposition");
    }
  }

  if (!Array.isArray(record.acceptedRisks) || record.acceptedRisks.length < 2) {
    errors.push("accepted risks must be recorded");
  }
  for (const risk of record.acceptedRisks ?? []) {
    if (!risk.id || !risk.ownerProject || !risk.mitigation || !risk.launchNote) {
      errors.push("accepted risks require id, owner project, mitigation, and launch note");
    }
  }

  if (!Array.isArray(record.crossProjectDependencies) || record.crossProjectDependencies.length < 4) {
    errors.push("cross-project dependencies must be recorded");
  }
  for (const dependency of record.crossProjectDependencies ?? []) {
    if (!dependency.ownerProject || !dependency.dependency) {
      errors.push("cross-project dependencies require owner project and dependency");
    }
  }

  for (const missing of record.missingEvidence ?? []) {
    if (!missing.id || !missing.ownerProject || !missing.reason) {
      errors.push("missing evidence requires id, owner project, and reason");
    }
  }

  const assetKinds = new Set<string>();
  for (const asset of record.demoAssets ?? []) {
    assetKinds.add(asset.kind);
    if (!asset.ownerProject || !asset.sourceEvidenceId || !asset.refreshTrigger) {
      errors.push("demo assets require owner project, source evidence, and refresh trigger");
    }
    if (!VALID_PROOF_MODES.has(asset.proofMode)) {
      errors.push(`${asset.kind} has invalid proof mode`);
    }
    if (!acceptedEvidenceIds.has(asset.sourceEvidenceId)) {
      errors.push(`${asset.kind} references non-accepted evidence`);
    }
  }

  for (const kind of REQUIRED_DEMO_ASSETS) {
    if (!assetKinds.has(kind)) errors.push(`missing ${kind} demo asset`);
  }

  if (record.publicationGate.publicOrGaPromotionAllowed) {
    errors.push("private beta evidence cannot promote public or GA launch claims");
  }
  if (!record.publicationGate.privateBetaPublicationAllowed) {
    errors.push("private beta publication gate must be explicit");
  }

  for (const followUp of record.followUpIssues ?? []) {
    if (!followUp.ownerProject || !followUp.missingEvidenceId || !followUp.allowedReason) {
      errors.push("follow-ups require owner project, missing evidence, and allowed reason");
    }
    if (!missingEvidenceIds.has(followUp.missingEvidenceId)) {
      errors.push("follow-up is allowed only for missing evidence");
    }
  }

  if (record.parentInitiativeSync.launchRiskChanged && !record.parentInitiativeSync.statusUpdated) {
    errors.push("parent initiative status must be updated");
  }

  if ((record.scopeOut ?? []).some((item) => /build.*launch.*site|final visual assets|publish final launch copy/i.test(item)) === false) {
    errors.push("scope-out must reject launch-site build and final-publication work");
  }

  return { ok: errors.length === 0, errors };
}

export function assertLaunchSitePrivateBetaEvidence(record = launchSitePrivateBetaEvidence) {
  const result = validateLaunchSitePrivateBetaEvidence(record);

  if (!result.ok) {
    throw new Error(`launch site private beta evidence invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}

import { isJsonObject } from "./json.js";
const VALID_CLAIM_STATES = new Set(["implemented", "simulated-reference", "beta-only", "future-roadmap"]);
const VALID_RISK_RATINGS = new Set(["low", "medium", "high"]);
const VALID_PROOF_MODES = new Set(["design-record", "contract-test", "reference-fixture", "live-recording", "manual-review"]);
const LAUNCH_SITE_PATTERNS = [/launch-site/i, /published-page/i, /ship the public launch site/i];

export const launchMessagingClaimRegister = {
  schema: "hobo.launch-messaging-claim-register/2026-06-29",
  issue: "HOBO-406",
  project: "V1 Launch Site, Messaging & Demo Assets",
  phase: "M0",
  publicClaims: [
    {
      id: "claim.ai-native-meta-cloud",
      claim:
        "HoBo is an AI-native meta-cloud that maps one app description onto provider-owned infrastructure through cloud-agnostic ports.",
      state: "implemented",
      evidenceOwner: "V1 Release Program & Cutline",
      evidenceSource: "src/draft/technical-proofs/v1-cutline-contract/README.md",
      riskRating: "medium",
      publicationDisposition: "candidate",
    },
    {
      id: "claim.example-proof-path",
      claim:
        "Launch demos can use accepted example-app proof modes to separate live behavior from reference or simulated evidence.",
      state: "simulated-reference",
      evidenceOwner: "Example Apps",
      evidenceSource: "docs/design/example-apps.md#m0-acceptance-record",
      riskRating: "medium",
      publicationDisposition: "candidate",
    },
    {
      id: "claim.beta-dogfood-ops",
      claim:
        "Dogfood and beta operations evidence can support private-beta messaging before broader GA operational claims are made.",
      state: "beta-only",
      evidenceOwner: "V1 Dogfood Yard & Hosted Operations",
      evidenceSource: "HOBO-403",
      riskRating: "high",
      publicationDisposition: "follow-up",
    },
    {
      id: "claim.release-notes-known-limitations",
      claim:
        "Customer-facing release notes will distinguish supported install paths, upgrade guidance, known limitations, and support contacts.",
      state: "future-roadmap",
      evidenceOwner: "V1 Release Notes & Upgrade Guide",
      evidenceSource: "HOBO-407",
      riskRating: "medium",
      publicationDisposition: "follow-up",
    },
    {
      id: "claim.agent-operator-workforce",
      claim:
        "Built-in operator agents are part of the product story, but launch wording must stay tied to current Crew design and proof evidence.",
      state: "future-roadmap",
      evidenceOwner: "Operators/SRE",
      evidenceSource: "docs/design/operators-sre.md#plan-40",
      riskRating: "high",
      publicationDisposition: "scope-out-until-proven",
    },
  ],
  demoAssets: [
    {
      kind: "claim-index",
      owner: "launch messaging owner",
      proofMode: "design-record",
      refreshTrigger: "Any public-facing claim changes state, owner, or evidence source.",
    },
    {
      kind: "demo-script",
      owner: "demo maintainer",
      proofMode: "manual-review",
      refreshTrigger: "Golden path, persona, or unsupported-state wording changes.",
    },
    {
      kind: "command-transcript",
      owner: "Example Apps",
      proofMode: "reference-fixture",
      refreshTrigger: "Example app command path, fixture output, or CLI wording changes.",
    },
    {
      kind: "screenshot-set",
      owner: "V1 Launch Site, Messaging & Demo Assets",
      proofMode: "live-recording",
      refreshTrigger: "UI surface, proof-mode label, or launch visual changes.",
    },
    {
      kind: "recording-manifest",
      owner: "V1 Launch Site, Messaging & Demo Assets",
      proofMode: "live-recording",
      refreshTrigger: "Demo recording, expected output, or simulated/reference marker changes.",
    },
  ],
  scopeOut: [
    {
      id: "scope-out.launch-site-build",
      reason: "HOBO-406 drafts the claim register; it does not build or publish the launch site.",
      disposition: "V1 Launch Site implementation issue",
    },
    {
      id: "scope-out.unproven-production-readiness",
      reason: "Production-readiness claims need beta, RC, or GA evidence before publication.",
      disposition: "Known limitation or go/no-go blocker",
    },
    {
      id: "scope-out.unsupported-provider-coverage",
      reason: "Provider, runtime, billing, support, and operations claims stay scoped to their owner evidence.",
      disposition: "Owner project follow-up",
    },
  ],
  followUps: [
    {
      claimId: "claim.beta-dogfood-ops",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      reason: "Replace beta-only wording with accepted dogfood/beta telemetry evidence before GA.",
    },
    {
      claimId: "claim.release-notes-known-limitations",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      reason: "Attach the accepted release notes outline and known-limitations register.",
    },
    {
      claimId: "claim.agent-operator-workforce",
      ownerProject: "Operators/SRE",
      reason: "Keep Crew messaging tied to design/proof evidence rather than promising live support automation.",
    },
  ],
};

export function validateLaunchMessagingClaimRegister(record) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch messaging claim register is required"] };
  }

  if (record.issue !== "HOBO-406") {
    errors.push("issue must be HOBO-406");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  const followUpClaimIds = new Set((record.followUps ?? []).map((followUp) => followUp.claimId));
  const scopeOutText = JSON.stringify(record.scopeOut ?? []);

  for (const claim of record.publicClaims ?? []) {
    if (!claim.id || !claim.claim) {
      errors.push("public claims require id and claim text");
    }
    if (!claim.evidenceOwner || !claim.evidenceSource) {
      errors.push("public claims require evidence owner and source");
    }
    if (!VALID_CLAIM_STATES.has(claim.state)) {
      errors.push(`${claim.id ?? "<unknown>"} has invalid claim state`);
    }
    if (!VALID_RISK_RATINGS.has(claim.riskRating)) {
      errors.push(`${claim.id ?? "<unknown>"} has invalid risk rating`);
    }
    if (
      claim.riskRating === "high" &&
      claim.publicationDisposition === "publish" &&
      !followUpClaimIds.has(claim.id) &&
      !scopeOutText.includes(claim.id)
    ) {
      errors.push("high-risk claims require follow-up or scope-out routing");
    }
  }

  for (const required of ["implemented", "simulated-reference", "beta-only", "future-roadmap"]) {
    if (!(record.publicClaims ?? []).some((claim) => claim.state === required)) {
      errors.push(`missing ${required} claim state`);
    }
  }

  for (const asset of record.demoAssets ?? []) {
    if (!asset.kind || !asset.owner || !asset.refreshTrigger) {
      errors.push("demo assets require kind, owner, and refreshTrigger");
    }
    if (!VALID_PROOF_MODES.has(asset.proofMode)) {
      errors.push(`${asset.kind ?? "<unknown>"} has invalid proof mode`);
    }
    if (LAUNCH_SITE_PATTERNS.some((pattern) => pattern.test(`${asset.kind} ${asset.proofMode} ${asset.refreshTrigger}`))) {
      errors.push("launch site implementation is scope-out");
    }
  }

  for (const followUp of record.followUps ?? []) {
    if (!followUp.claimId || !followUp.ownerProject || !followUp.reason) {
      errors.push("follow-ups require claimId, ownerProject, and reason");
    }
  }

  if (!Array.isArray(record.scopeOut) || record.scopeOut.length < 3) {
    errors.push("scope-out must list unsupported or risky claim routes");
  }
  if (!Array.isArray(record.followUps) || record.followUps.length < 3) {
    errors.push("follow-ups must list risky claim owners");
  }

  return { ok: errors.length === 0, errors };
}

export function assertLaunchMessagingClaimRegister(record = launchMessagingClaimRegister) {
  const result = validateLaunchMessagingClaimRegister(record);

  if (!result.ok) {
    throw new Error(`launch messaging claim register invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}

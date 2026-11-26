import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
const REQUIRED_LIMITATION_FIELDS = [
  "id",
  "summary",
  "state",
  "affectedPersona",
  "userVisibleImpact",
  "workaround",
  "owner",
] as const;

const REQUIRED_HANDOFF_TARGETS = ["release-notes", "support-scripts", "docs-portal", "launch-messaging"] as const;
const REQUIRED_REVIEW_GATES = ["beta", "ga"] as const;

const LIMITED_CLAIM_PATTERN = /\b(beta-only|simulated|reference|unsupported|deferred|post-ga|follow-up|known limitation|limited)\b/i;
const SUPPORTED_CLAIM_PATTERN = /\b(supported|available|launch-ready|ga-ready|ships|included)\b/i;
const SCOPE_OUT_MARKETING_PATTERN = /\b(live hosted dashboard|production provider deploy|automated support desk|full migration automation|all providers|unsupported environment|post-ga roadmap|fully unsupervised crew|unsupervised crew or mcp)\b/i;

declare const parsedKnownLimitationsRegisterBrand: unique symbol;

export type LimitationState = "real" | "beta-only" | "simulated-reference" | "unsupported" | "deferred" | "post-ga";
export type ReviewGate = (typeof REQUIRED_REVIEW_GATES)[number];

// domain-view: parse-produced draft-proof record; its wire form is the KnownLimitation proto message in data-models/.
export type KnownLimitation = {
  readonly id: string;
  readonly summary: string;
  readonly state: LimitationState;
  readonly affectedPersona: string;
  readonly userVisibleImpact: string;
  readonly workaround: string;
  readonly owner: string;
  readonly followUpIssue?: string;
  readonly requiresFollowUp: boolean;
  readonly releaseNoteSection: string;
  readonly supportScriptRoute: string;
  readonly docsRoute: string;
  readonly launchMessagingDisposition: string;
  readonly internalNotes?: string;
};

export type HandoffTarget = {
  readonly id: (typeof REQUIRED_HANDOFF_TARGETS)[number];
  readonly owner: string;
  readonly consumes: readonly string[];
  readonly requiredEvidence: readonly string[];
};

export type ReviewCheckpoint = {
  readonly gate: ReviewGate;
  readonly owner: string;
  readonly requiredFields: readonly string[];
  readonly blocksPublicationWhenStale: boolean;
};

// domain-view: parse-produced draft-proof record; its wire form is the KnownLimitationsRegister proto message in data-models/.
export type KnownLimitationsRegister = {
  readonly schema: string;
  readonly issue: "HOBO-485";
  readonly project: "V1 Release Notes & Upgrade Guide";
  readonly phase: "M0";
  readonly purpose: string;
  readonly limitations: readonly KnownLimitation[];
  readonly handoffTargets: readonly HandoffTarget[];
  readonly reviewCheckpoints: readonly ReviewCheckpoint[];
  readonly scopeOutMarketingGuard: {
    readonly rule: string;
    readonly forbiddenPhrases: readonly string[];
    readonly allowedFraming: readonly string[];
  };
};

export type ParsedKnownLimitationsRegister = KnownLimitationsRegister & {
  readonly [parsedKnownLimitationsRegisterBrand]: "ParsedKnownLimitationsRegister";
};

export const KNOWN_LIMITATIONS_REGISTER: KnownLimitationsRegister = {
  schema: "hobo.draft.known_limitations_register/v1",
  issue: "HOBO-485",
  project: "V1 Release Notes & Upgrade Guide",
  phase: "M0",
  purpose:
    "Customer-facing register for v1 limitations, scope-out claims, beta-only evidence, simulated proof, unsupported states, and post-GA follow-up routing.",
  limitations: [
    {
      id: "supported-paths-are-evidence-backed-only",
      summary: "Only release-candidate paths with accepted evidence are real supported v1 capabilities.",
      state: "real",
      affectedPersona: "customer admin choosing a launch path",
      userVisibleImpact:
        "Release notes can name supported SaaS, self-host, or local paths only when evidence exists.",
      workaround: "Choose an evidence-backed launch path or treat the request as a limitation.",
      owner: "V1 Release Program & Cutline",
      requiresFollowUp: false,
      releaseNoteSection: "Supported install paths",
      supportScriptRoute: "supported launch-path response",
      docsRoute: "release-notes/supported-install-paths",
      launchMessagingDisposition: "implemented claims must cite accepted cutline evidence",
    },
    {
      id: "reference-proof-not-live-hosted",
      summary: "Some launch proof is reference-fixture or contract evidence, not live hosted behavior.",
      state: "simulated-reference",
      affectedPersona: "buyer evaluating launch claims",
      userVisibleImpact:
        "Customer-facing copy must label reference proof separately from production hosted evidence.",
      workaround: "Use proof-mode labels and link the accepted contract or demo fixture before publication.",
      owner: "V1 Launch Site, Messaging & Demo Assets",
      followUpIssue: "HOBO-458",
      requiresFollowUp: true,
      releaseNoteSection: "Known limitations",
      supportScriptRoute: "explain proof mode and route live-behavior questions to launch owner",
      docsRoute: "docs-portal/known-limitations",
      launchMessagingDisposition: "simulated-reference claims require proof-mode wording",
      internalNotes: "Do not expose internal launch-copy debate in release notes.",
    },
    {
      id: "beta-operations-evidence",
      summary: "Dogfood and private-beta operations evidence is not GA operational proof.",
      state: "beta-only",
      affectedPersona: "private-beta customer admin",
      userVisibleImpact: "Beta users may see operational caveats and support routing before GA evidence exists.",
      workaround: "Publish beta-only wording with support route, accepted risk, and review gate.",
      owner: "V1 Dogfood Yard & Hosted Operations",
      followUpIssue: "HOBO-455",
      requiresFollowUp: true,
      releaseNoteSection: "Known limitations",
      supportScriptRoute: "route operations confidence questions to dogfood and support owners",
      docsRoute: "release-notes/beta-limitations",
      launchMessagingDisposition: "private-beta only until GA evidence is accepted",
    },
    {
      id: "unsupported-install-environments",
      summary: "Unsupported install environments stay outside supported v1 bootstrap claims.",
      state: "unsupported",
      affectedPersona: "self-host operator",
      userVisibleImpact: "Operators outside the smoke matrix receive limitation text instead of support promises.",
      workaround: "Use supported SaaS, self-host, or local paths with accepted smoke evidence.",
      owner: "Bootstrap Installer",
      followUpIssue: "HOBO-501",
      requiresFollowUp: true,
      releaseNoteSection: "Supported install paths",
      supportScriptRoute: "bootstrap unsupported-environment response",
      docsRoute: "bootstrap-installer#scope-out",
      launchMessagingDisposition: "must not be described as supported install breadth",
    },
    {
      id: "rollback-drill-not-production-recovery-guarantee",
      summary: "Backup/restore drills and upgrade dry-runs do not become production recovery guarantees.",
      state: "post-ga",
      affectedPersona: "release owner and support operator",
      userVisibleImpact:
        "Rollback guidance distinguishes accepted drill evidence from unsupported production recovery promises.",
      workaround: "Link drill evidence and state unsupported rollback paths explicitly.",
      owner: "Backup & Restore",
      followUpIssue: "HOBO-498",
      requiresFollowUp: true,
      releaseNoteSection: "Rollback guidance",
      supportScriptRoute: "backup-restore limitation and escalation response",
      docsRoute: "backup-restore#scope-out",
      launchMessagingDisposition: "post-GA follow-up unless release-candidate recovery evidence is accepted",
    },
    {
      id: "full-migration-automation-deferred",
      summary: "Full migration automation remains deferred outside the v1 release-note scope.",
      state: "deferred",
      affectedPersona: "workspace administrator planning a migration",
      userVisibleImpact:
        "Migration notes can describe supported manual guidance and compatibility evidence, not complete automation.",
      workaround: "Use documented migration guidance and compatibility notes until automation evidence lands.",
      owner: "Upgrade & Migration",
      followUpIssue: "HOBO-430",
      requiresFollowUp: true,
      releaseNoteSection: "Migration notes",
      supportScriptRoute: "migration guidance limitation response",
      docsRoute: "upgrade-migration#scope-out",
      launchMessagingDisposition: "deferred; cannot be sold as v1 migration automation",
    },
    {
      id: "live-support-automation-out-of-scope",
      summary: "Automated support desk, ticket queues, and live support tooling are not implemented by M0 docs.",
      state: "unsupported",
      affectedPersona: "support lead",
      userVisibleImpact:
        "Support copy can describe channels and escalation coverage, not live support automation.",
      workaround: "Use support SLA/channel records and manual support scripts until tooling evidence lands.",
      owner: "Support Workflow",
      followUpIssue: "HOBO-448",
      requiresFollowUp: true,
      releaseNoteSection: "Support contacts",
      supportScriptRoute: "manual support routing and unsupported automation response",
      docsRoute: "support-sla-channels#unsupported-request-classes",
      launchMessagingDisposition: "scope-out; cannot be marketed as supported v1 capability",
    },
    {
      id: "crew-mcp-write-actions-policy-gated",
      summary: "Crew and MCP write actions are policy-gated, not fully unsupervised.",
      state: "real",
      affectedPersona: "platform operator and external MCP agent integrator",
      userVisibleImpact:
        "Launch and docs copy must not promise unattended Crew or MCP mutations; read and diagnose runs autonomously but remediation, deploy, and other writes require approval or policy gates.",
      workaround:
        "Route write-action expectations through dashboard or Slack approval flows and scoped MCP grants documented for the Crew roster.",
      owner: "Operator Agents & SRE",
      requiresFollowUp: false,
      releaseNoteSection: "Known limitations",
      supportScriptRoute: "crew and MCP autonomy limitation response",
      docsRoute: "docs-portal/known-limitations#crew-mcp-autonomy",
      launchMessagingDisposition:
        "must not be described as fully unsupervised Crew or MCP write autonomy",
    },
  ],
  handoffTargets: [
    {
      id: "release-notes",
      owner: "V1 Release Notes & Upgrade Guide",
      consumes: ["releaseNoteSection", "state", "userVisibleImpact", "workaround", "owner"],
      requiredEvidence: ["customer-visible wording", "owner", "state", "review checkpoint"],
    },
    {
      id: "support-scripts",
      owner: "Support Workflow",
      consumes: ["supportScriptRoute", "workaround", "owner", "followUpIssue"],
      requiredEvidence: ["support route", "unsupported request class", "escalation owner"],
    },
    {
      id: "docs-portal",
      owner: "Docs Portal",
      consumes: ["docsRoute", "state", "releaseNoteSection"],
      requiredEvidence: ["docs route", "freshness owner", "known-limitation metadata"],
    },
    {
      id: "launch-messaging",
      owner: "V1 Launch Site, Messaging & Demo Assets",
      consumes: ["launchMessagingDisposition", "state", "owner", "followUpIssue"],
      requiredEvidence: ["claim state", "proof mode", "approved limitation wording"],
    },
  ],
  reviewCheckpoints: [
    {
      gate: "beta",
      owner: "V1 Release Program & Cutline",
      requiredFields: ["owner", "customerVisibleText", "state", "supportRoute", "followUpIssue"],
      blocksPublicationWhenStale: true,
    },
    {
      gate: "ga",
      owner: "V1 Release Program & Cutline",
      requiredFields: ["owner", "customerVisibleText", "state", "reviewedAt", "gaDisposition"],
      blocksPublicationWhenStale: true,
    },
  ],
  scopeOutMarketingGuard: {
    rule: "A scope-out or unsupported item may appear only as a known limitation, beta caveat, simulated-reference note, deferred item, or follow-up. It cannot be marketed as supported v1 capability.",
    forbiddenPhrases: [
      "live hosted dashboard is supported at v1",
      "all providers are supported",
      "automated support desk ships in v1",
      "production recovery guarantee",
      "fully unsupervised crew or mcp write autonomy ships in v1",
    ],
    allowedFraming: ["real", "beta-only", "simulated-reference", "unsupported", "deferred", "post-ga"],
  },
};

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value !== null;
}

export function validateKnownLimitationsRegister(record: KnownLimitationsRegister) {
  const errors: string[] = [];

  if (record.issue !== "HOBO-485") {
    errors.push("issue must be HOBO-485");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  for (const limitation of record.limitations ?? []) {
    for (const field of REQUIRED_LIMITATION_FIELDS) {
      const value = limitation[field];
      if (!isJsonString(value) || value.length === 0) {
        errors.push(`${limitation.id ?? "<missing>"} is missing ${field}`);
      }
    }
    if (limitation.requiresFollowUp && !limitation.followUpIssue) {
      errors.push(`${limitation.id} requires a follow-up issue`);
    }
    if (!limitation.releaseNoteSection || !limitation.supportScriptRoute || !limitation.docsRoute) {
      errors.push(`${limitation.id} must map to release notes, support scripts, and docs`);
    }
    if (!limitation.launchMessagingDisposition) {
      errors.push(`${limitation.id} must map to launch messaging`);
    }
  }

  const targetIds = (record.handoffTargets ?? []).map((target) => target.id);
  for (const target of REQUIRED_HANDOFF_TARGETS) {
    if (!targetIds.includes(target)) {
      errors.push(`missing handoff target: ${target}`);
    }
  }
  for (const target of record.handoffTargets ?? []) {
    if (!target.owner || target.consumes.length === 0 || target.requiredEvidence.length === 0) {
      errors.push(`${target.id} handoff must name owner, consumed fields, and evidence`);
    }
  }

  const gates = (record.reviewCheckpoints ?? []).map((checkpoint) => checkpoint.gate);
  for (const gate of REQUIRED_REVIEW_GATES) {
    if (!gates.includes(gate)) {
      errors.push(`missing review checkpoint: ${gate}`);
    }
  }
  for (const checkpoint of record.reviewCheckpoints ?? []) {
    if (!checkpoint.requiredFields.includes("owner") || !checkpoint.requiredFields.includes("customerVisibleText")) {
      errors.push(`${checkpoint.gate} checkpoint must require owner and customerVisibleText`);
    }
    if (!checkpoint.blocksPublicationWhenStale) {
      errors.push(`${checkpoint.gate} checkpoint must block stale publication`);
    }
  }

  const guardText = `${record.scopeOutMarketingGuard?.rule ?? ""} ${(record.scopeOutMarketingGuard?.allowedFraming ?? []).join(" ")}`;
  if (!/cannot be marketed as supported v1 capability/i.test(guardText)) {
    errors.push("scope-out guard must block supported-v1 marketing");
  }

  return { ok: errors.length === 0, errors, record };
}

export function parseKnownLimitationsRegister(input: JsonValue): ParsedKnownLimitationsRegister {
  if (!isRecord(input)) {
    throw new Error("known limitations register must be an object");
  }

  for (const field of ["limitations", "handoffTargets", "reviewCheckpoints"] as const) {
    if (!Array.isArray(input[field])) {
      throw new Error(`known limitations register must include ${field} array`);
    }
  }

  // SAFETY: `const result = validateKnownLimitationsRegister(input as KnownLimitationsRegiste` is required at this I/O or test boundary.
  const result = validateKnownLimitationsRegister(input as KnownLimitationsRegister);
  if (!result.ok) {
    throw new Error(`known limitations register invalid:\n${result.errors.join("\n")}`);
  }

  // SAFETY: `return result.record as ParsedKnownLimitationsRegister;` is required at this I/O or test boundary.
  return result.record as ParsedKnownLimitationsRegister;
}

export function classifyScopeOutClaim(text: string) {
  if (SUPPORTED_CLAIM_PATTERN.test(text) && SCOPE_OUT_MARKETING_PATTERN.test(text)) {
    return {
      allowed: false,
      reason: "scope-out item cannot be marketed as supported v1 capability",
      route: "known-limitations-register",
    } as const;
  }

  if (LIMITED_CLAIM_PATTERN.test(text)) {
    return {
      allowed: true,
      reason: "claim is framed as limited, beta, simulated, deferred, unsupported, or follow-up",
      route: "release-notes",
    } as const;
  }

  return {
    allowed: true,
    reason: "claim does not market a known scope-out item as supported",
    route: "launch-messaging-review",
  } as const;
}

export function createReleaseNoteView(record: ParsedKnownLimitationsRegister) {
  return {
    issue: record.issue,
    section: "Known limitations",
    entries: record.limitations.map((limitation) => ({
      id: limitation.id,
      summary: limitation.summary,
      state: limitation.state,
      affectedPersona: limitation.affectedPersona,
      userVisibleImpact: limitation.userVisibleImpact,
      workaround: limitation.workaround,
      owner: limitation.owner,
      followUpIssue: limitation.followUpIssue,
      releaseNoteSection: limitation.releaseNoteSection,
    })),
  };
}

import { type JsonValue } from "./json.js";
export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "channel-taxonomy-record",
  "transition-owner-matrix",
  "evidence-checklist-fixture",
  "go-no-go-decision-template",
  "publication-support-handoff",
  "scope-boundary-register",
]);

const REQUIRED_RELEASE_EVIDENCE = Object.freeze([
  "cutline",
  "artifact-provenance",
  "compatibility-matrix",
  "known-limitations",
  "support-route",
  "rollback-policy",
  "customer-communication",
  "decision-record",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "deployment",
    pattern: /\b(live deployment|promotion automation|rollout automation|deploy runtime|traffic shift)\b/i,
  },
  {
    label: "artifact",
    pattern: /\b(artifact signing storage|package publication runtime|publish packages?|registry storage|release artifact store)\b/i,
  },
  {
    label: "compatibility",
    pattern: /\b(generate .*compatibility matrix|browser .*coverage|device .*coverage|compatibility matrix results)\b/i,
  },
  {
    label: "messaging",
    pattern: /\b(marketing pages?|customer email campaigns?|launch campaign|publish launch)\b/i,
  },
  {
    label: "support",
    pattern: /\b(support ticket|sla automation|ticket routing|live escalation workflow)\b/i,
  },
  {
    label: "follow-up",
    pattern: /\b(create M[1-4]|M[1-4] implementation issues?|downstream implementation issues?)\b/i,
  },
]);

export const RELEASE_CHANNELS_SCOPE = Object.freeze({
  issue: "HOBO-431",
  project: "Release Channels",
  phase: "M0",
  goal:
    "Define Release Channels scope and acceptance so dogfood, beta, release-candidate, GA, and patch channels have accepted evidence gates before downstream design or build work fans out.",
  personas: Object.freeze([
    {
      id: "release-owner",
      name: "Release owner",
      need:
        "Needs a channel taxonomy, go/no-go evidence, and decision records before declaring beta, RC, GA, or patch readiness.",
    },
    {
      id: "platform-operator",
      name: "Platform operator",
      need:
        "Needs to know which artifacts, compatibility records, rollback expectations, and support handoffs are required before publishing a channel.",
    },
    {
      id: "application-developer",
      name: "Application developer",
      need:
        "Needs clear channel labels and limitations so preview, beta, GA, and patch claims do not overstate supported behavior.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need:
        "Needs customer-safe support routes, known limitations, and rollback or pause evidence for each channel state.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define launch release channel classes for dogfood, private-beta, public-beta, release-candidate, GA, and patch channels.",
    "Record channel states from proposed through evidence-collecting, go/no-go-review, approved, published, paused, superseded, and retired.",
    "Define transition ownership for propose, approve, publish, pause, supersede, retire, and emergency patch decisions.",
    "Define required evidence fields for cutline, artifact provenance, compatibility matrix, known limitations, support route, rollback policy, customer communication, and decision record.",
    "Map service, UX, security, and support boundaries for downstream M1 design and contract proof.",
    "List M1 evidence required before release notes, artifact retention, compatibility, beta, support, or status-page work can depend on this record.",
  ]),
  scopeOut: Object.freeze([
    "No live deployment promotion automation, rollout execution, traffic shifting, or deploy runtime implementation.",
    "No artifact signing service, package publication runtime, registry storage, or release artifact store implementation.",
    "No compatibility matrix generation, browser-grid execution, device-lab work, or platform certification runtime.",
    "No launch marketing site, campaign copy publication, customer email automation, or press/demo asset production.",
    "No support ticket routing, SLA automation, live incident escalation workflow, or status-page publishing runtime.",
    "No security attestation engine, policy approval runtime, vulnerability workflow, or legal/privacy signoff implementation.",
    "No downstream M1-M4 implementation issue creation before this M0 scope record is accepted.",
  ]),
  nonGoals: Object.freeze([
    "Replace V1 Release Program & Cutline gate ownership.",
    "Build deployment, artifact, compatibility, marketing, status-page, or support runtime behavior.",
    "Approve any current channel for beta, release-candidate, GA, or patch publication.",
    "Create implementation follow-ups before M0 acceptance evidence is approved.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Release Channels",
      promise:
        "Owns channel taxonomy, states, transitions, evidence fields, and the follow-up gate; release execution stays later.",
    },
    {
      id: "ux",
      owner: "Release Notes & Upgrade Guide / Launch Messaging Claims",
      promise:
        "Defines labels, limitations, and communication inputs only; rendered release pages and campaigns stay later.",
    },
    {
      id: "security",
      owner: "Security Verification / Release Artifact Provenance & Retention",
      promise:
        "Names artifact, provenance, compatibility, and vulnerability evidence without implementing attestation engines.",
    },
    {
      id: "support",
      owner: "Launch Support Desk & Escalation",
      promise:
        "Defines support route and customer-safe pause/rollback handoff without ticketing or SLA automation.",
    },
  ]),
  channelClasses: Object.freeze([
    {
      id: "dogfood",
      definition: "Internal hosted or self-hosted use proving operational readiness before customer claims.",
    },
    {
      id: "private-beta",
      definition: "Invite-only customer or partner use with explicit limitations and support route.",
    },
    {
      id: "public-beta",
      definition: "Publicly accessible beta posture with visible limitation, rollback, and feedback evidence.",
    },
    {
      id: "release-candidate",
      definition: "Near-final release posture waiting on cutline, compatibility, support, and known-limitation evidence.",
    },
    {
      id: "ga",
      definition: "General availability posture requiring durable support, compatibility, provenance, and decision evidence.",
    },
    {
      id: "patch",
      definition: "Narrow corrective release channel linked to an approved parent channel and rollback posture.",
    },
  ]),
  channelStates: Object.freeze([
    {
      id: "proposed",
      meaning: "A channel intent exists but required evidence is not yet collected or accepted.",
    },
    {
      id: "evidence-collecting",
      meaning: "Owners are collecting release evidence without claiming publish readiness.",
    },
    {
      id: "go-no-go-review",
      meaning: "Decision owners are reviewing evidence, blockers, accepted risks, and support posture.",
    },
    {
      id: "approved",
      meaning: "Decision record permits publication when downstream publishing work exists.",
    },
    {
      id: "published",
      meaning: "Channel is customer-visible and carries linked evidence plus support route.",
    },
    {
      id: "paused",
      meaning: "Channel remains documented but new adoption is stopped pending evidence or rollback decisions.",
    },
    {
      id: "superseded",
      meaning: "A newer channel or patch replaces the prior one while preserving audit and support history.",
    },
    {
      id: "retired",
      meaning: "Channel is no longer active and has end-of-support or migration evidence.",
    },
  ]),
  requiredEvidence: Object.freeze([
    {
      id: "cutline",
      owner: "V1 Release Program & Cutline",
      proof: "Names the scope, blockers, accepted risks, and owner signoff required for the channel.",
    },
    {
      id: "artifact-provenance",
      owner: "Release Artifact Provenance & Retention",
      proof: "Links release artifact identity, provenance, retention, invalidation, and support/debug access evidence.",
    },
    {
      id: "compatibility-matrix",
      owner: "Compatibility Matrix",
      proof: "Names supported browser, device, platform, CLI, local bootstrap, and limitation evidence consumed by the channel.",
    },
    {
      id: "known-limitations",
      owner: "Release Notes & Upgrade Guide",
      proof: "Lists customer-visible limitations and scope-out items that must not be marketed as supported.",
    },
    {
      id: "support-route",
      owner: "Launch Support Desk & Escalation",
      proof: "Names support channel, escalation route, unsupported request routing, and response posture.",
    },
    {
      id: "rollback-policy",
      owner: "Release Notes & Upgrade Guide",
      proof: "Records rollback, pause, supersede, and patch expectations without implementing deployment rollback.",
    },
    {
      id: "customer-communication",
      owner: "Public Status Page & Incident Communication",
      proof: "Names customer-visible messaging, maintenance/incident posture, and communication cadence inputs.",
    },
    {
      id: "decision-record",
      owner: "V1 Release Program & Cutline",
      proof: "Records go/no-go decision, approver role, evidence links, accepted risks, expiry, and revisit date.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/release-notes-upgrade-guide.md",
    "docs/design/release-artifact-provenance-retention.md",
    "docs/design/compatibility-matrix.md",
    "docs/design/beta-pilot-feedback.md",
    "docs/design/launch-messaging-claims.md",
    "docs/design/support-sla-channels.md",
    "docs/design/public-status-page-incident-communication.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/07-portability-extensibility.md#adr-0063",
    "docs/design/adr/07-portability-extensibility.md#adr-0064",
    "docs/design/adr/07-portability-extensibility.md#adr-0095",
    "docs/design/adr/07-portability-extensibility.md#adr-0075",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Release Channels",
      boundary:
        "Owns channel taxonomy, states, transition owners, evidence fields, and M1 proof gate.",
    },
    {
      owner: "V1 Release Program & Cutline",
      boundary:
        "Supplies cutline, blocker, risk-acceptance, and go/no-go decision ownership consumed by channel state.",
    },
    {
      owner: "Release Artifact Provenance & Retention",
      boundary:
        "Supplies artifact identity, provenance, retention, invalidation, and support/debug inputs.",
    },
    {
      owner: "Compatibility Matrix",
      boundary:
        "Supplies supported browser, device, platform, CLI, bootstrap, and known unsupported-state evidence.",
    },
    {
      owner: "Release Notes & Upgrade Guide",
      boundary:
        "Consumes channel state and evidence to publish release notes, limitations, upgrade, and rollback guidance later.",
    },
    {
      owner: "Beta Pilot & Feedback Loop",
      boundary:
        "Supplies beta cohort, feedback, and release-candidate exit evidence without owning final channel approval.",
    },
    {
      owner: "Launch Support Desk & Escalation",
      boundary:
        "Consumes channel state, known limitations, pause/rollback evidence, and customer-safe support handoff.",
    },
    {
      owner: "Public Status Page & Incident Communication",
      boundary:
        "Consumes published, paused, superseded, and retired states for future customer communication workflows.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "channel-taxonomy-record",
      mode: "design-record",
      proves: "Dogfood, private beta, public beta, RC, GA, and patch channels have stable definitions.",
    },
    {
      id: "transition-owner-matrix",
      mode: "reference-fixture",
      proves: "Propose, approve, publish, pause, supersede, retire, and patch transitions route to named owners.",
    },
    {
      id: "evidence-checklist-fixture",
      mode: "contract-test",
      proves: "Cutline, artifact, compatibility, limitation, support, rollback, communication, and decision evidence is required.",
    },
    {
      id: "go-no-go-decision-template",
      mode: "audit-fixture",
      proves: "Channel decisions carry evidence links, blockers, accepted risks, owner role, expiry, and revisit date.",
    },
    {
      id: "publication-support-handoff",
      mode: "support-handoff",
      proves: "Support can inspect customer-safe channel state, limitation, pause/rollback, and escalation data.",
    },
    {
      id: "scope-boundary-register",
      mode: "audit-fixture",
      proves: "Deployment, artifact, compatibility, messaging, support, security, and follow-up work route out.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Release Channels design or implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateReleaseChannelsFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Release Channels gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Release Channels scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 Release Channels scope.",
  };
}

export function classifyReleaseChannelsDecision(decision: JsonValue) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(cutline|go-no-go|decision record|accepted risk|release program)\b/.test(text)) {
    return { owner: "V1 Release Program & Cutline", inScope: false };
  }
  if (/\b(artifact provenance|artifact retention|artifact invalidation|debug access)\b/.test(text)) {
    return { owner: "Release Artifact Provenance & Retention", inScope: false };
  }
  if (/\b(compatibility matrix|browser coverage|device coverage|platform support)\b/.test(text)) {
    return { owner: "Compatibility Matrix", inScope: false };
  }
  if (/\b(release notes|upgrade guide|known limitation|rollback guidance)\b/.test(text)) {
    return { owner: "Release Notes & Upgrade Guide", inScope: false };
  }
  if (/\b(beta feedback|pilot feedback|cohort|feedback intake)\b/.test(text)) {
    return { owner: "Beta Pilot & Feedback Loop", inScope: false };
  }
  if (/\b(support ticket|support escalation|sla|unsupported request)\b/.test(text)) {
    return { owner: "Launch Support Desk & Escalation", inScope: false };
  }
  if (/\b(status page|incident communication|maintenance notice|customer communication)\b/.test(text)) {
    return { owner: "Public Status Page & Incident Communication", inScope: false };
  }

  return { owner: "Release Channels", inScope: true };
}

export function validateReleaseChannelsScope(scope: typeof RELEASE_CHANNELS_SCOPE) {
  const errors: string[] = [];

  if (scope.issue !== "HOBO-431") {
    errors.push("Scope record must be tied to HOBO-431.");
  }
  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }
  if (!scope.goal?.toLowerCase().includes("release channels")) {
    errors.push("Goal must name Release Channels.");
  }
  if ((scope.personas ?? []).length < 4) {
    errors.push("At least four primary personas are required.");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("Scope in must record at least five launch-critical entries.");
  }
  if ((scope.scopeOut ?? []).length < 6) {
    errors.push("Scope out must reject adjacent implementation work.");
  }

  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing ${boundary} boundary.`);
    }
  }
  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!scope.m1Evidence?.some((entry) => entry.id === evidence)) {
      errors.push(`Missing M1 evidence: ${evidence}.`);
    }
  }
  for (const field of REQUIRED_RELEASE_EVIDENCE) {
    if (!scope.requiredEvidence?.some((entry) => entry.id === field)) {
      errors.push(`Missing required release evidence: ${field}.`);
    }
  }
  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.mode || !evidence.proves) {
      errors.push(`Evidence ${evidence.id ?? "<unknown>"} must name proof mode and proof.`);
    }
  }
  for (const item of scope.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(item)) {
        errors.push(`M0 scope-in includes out-of-scope ${label} work: ${item}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

import { isJsonObject } from "./json.js";
export const REQUIRED_READINESS_DOMAINS = [
  "reference-architecture",
  "productization",
  "support",
  "legal-privacy",
  "documentation",
  "operations-readiness"
];

export const REQUIRED_DOGFOOD_ALPHA_EVIDENCE_IDS = [
  "cutline-baseline",
  "dogfood-alpha-outcome",
  "blocker-delta",
  "accepted-risk-register",
  "cross-project-handoff"
];

export const REQUIRED_PRIVATE_BETA_EVIDENCE_IDS = [
  "cutline-baseline",
  "private-beta-go-no-go",
  "blocker-delta",
  "accepted-risk-register",
  "cross-project-handoff"
];

export const REQUIRED_RELEASE_CANDIDATE_EVIDENCE_IDS = [
  "cutline-baseline",
  "release-candidate-go-no-go",
  "blocker-delta",
  "accepted-risk-register",
  "cross-project-handoff",
  "release-notes-readiness"
];

export const REQUIRED_GA_HANDOFF_EVIDENCE_IDS = [
  "cutline-baseline",
  "ga-go-no-go",
  "signed-launch-checklist",
  "support-handoff",
  "legal-privacy-posture",
  "blocker-delta",
  "accepted-risk-register",
  "cross-project-handoff",
  "readiness-dashboard-refresh"
];

export const v1Cutline = {
  schema: "hobo.v1.cutline/2026-06-29",
  issue: "HOBO-401",
  decisionStatus: "m0-scope-and-acceptance",
  inScope: [
    {
      id: "v1-cutline.scope-spine",
      decision: "Write one launch cutline that separates launch-blocking v1 readiness from post-v1 capability growth.",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "reference-architecture",
      blockerCategory: "v1-blocker.reference-architecture",
      evidenceRequired: ["v1 in-scope list", "v1 out-of-scope list", "owner map"],
      citations: [
        "docs/design/README.md#scope",
        "docs/design/adr/07-portability-extensibility.md#adr-0063",
        "docs/design/adr/07-portability-extensibility.md#adr-0064"
      ]
    },
    {
      id: "v1-cutline.productization",
      decision: "Launch-facing productization work is in scope when it proves install, onboarding, project lifecycle, dashboard, plan review, quota, billing, or release-readiness contracts.",
      ownerProject: "Workspace & Onboarding UX",
      readinessDomain: "productization",
      blockerCategory: "v1-blocker.productization",
      evidenceRequired: ["accepted M0 scope", "contract proof path", "explicit unsupported states"],
      citations: [
        "docs/design/architecture.md#plan-10",
        "docs/design/developer-experience.md#plan-07",
        "docs/design/worked-example.md#plan-19"
      ]
    },
    {
      id: "v1-cutline.support",
      decision: "Support readiness is in scope when it defines SLA posture, escalation, break-glass boundaries, status communication, and customer-facing handoff evidence.",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      blockerCategory: "v1-blocker.support",
      evidenceRequired: ["severity routing", "first responder path", "support/debug prerequisites"],
      citations: [
        "docs/design/developer-experience.md#plan-07",
        "docs/design/operators-sre.md#plan-40",
        "docs/design/adr/03-data-plane.md#adr-0058"
      ]
    },
    {
      id: "v1-cutline.legal-privacy",
      decision: "Legal, privacy, data inventory, and customer assurance evidence are in scope when they block beta or GA claims.",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      readinessDomain: "legal-privacy",
      blockerCategory: "v1-blocker.legal-privacy",
      evidenceRequired: ["owner or owning project", "release blocker vs limitation label", "evidence source"],
      citations: [
        "docs/design/governance-planes.md#plan-46",
        "docs/design/adr/02-identity-security.md#adr-0060",
        "docs/design/adr/02-identity-security.md#adr-0080"
      ]
    },
    {
      id: "v1-cutline.documentation",
      decision: "Launch docs are in scope when they state supported install paths, release notes, upgrade/rollback guidance, known limitations, and claim evidence.",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      blockerCategory: "v1-blocker.documentation",
      evidenceRequired: ["source-of-truth owner", "known limitation text", "upgrade and rollback outline"],
      citations: [
        "docs/design/developer-experience.md#plan-07",
        "docs/design/platform-engineering.md#plan-25",
        "docs/design/adr/07-portability-extensibility.md#adr-0062"
      ]
    },
    {
      id: "v1-cutline.operations-readiness",
      decision: "Dogfood, hosted/self-hosted operations, backup/restore, upgrade dry-run, status, and launch smoke evidence are in scope when they prove readiness without live customer dependency.",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      readinessDomain: "operations-readiness",
      blockerCategory: "v1-blocker.operations-readiness",
      evidenceRequired: ["scenario fixture", "telemetry evidence", "rollback or recovery path"],
      citations: [
        "docs/design/reliability-observability-cost.md#plan-05",
        "docs/design/platform-engineering.md#plan-25",
        "docs/design/adr/02-identity-security.md#adr-0082"
      ]
    }
  ],
  outOfScope: [
    {
      id: "scope-out.capability-implementation",
      decision: "Do not implement provider, runtime, dashboard, identity, billing, support, or operations capability work in the cutline issue.",
      postV1Disposition: "Create or claim execution issues only after the owning M0 acceptance is approved.",
      citations: [
        "docs/design/README.md#scope",
        "docs/design/adr/07-portability-extensibility.md#adr-0063"
      ]
    },
    {
      id: "scope-out.premature-m1-m4-task-creation",
      decision: "Do not create M1-M4 execution tasks before M0 cutline criteria and owner boundaries are accepted.",
      postV1Disposition: "Fan-out is deferred until M0 scope acceptance is recorded.",
      citations: [
        "docs/design/architecture.md#plan-10",
        "docs/design/adr/07-portability-extensibility.md#adr-0018"
      ]
    },
    {
      id: "scope-out.legal-text",
      decision: "Do not draft final terms, privacy notices, DPA language, or compliance claims without the legal owner supplying or approving text.",
      postV1Disposition: "Track as legal/privacy readiness blocker or explicit launch limitation.",
      citations: [
        "docs/design/governance-planes.md#plan-46",
        "docs/design/adr/02-identity-security.md#adr-0060"
      ]
    },
    {
      id: "scope-out.live-customer-proof",
      decision: "Do not use live customer data or promise production operational proof from dogfood-only fixtures.",
      postV1Disposition: "Require beta/GA evidence before customer-facing claim promotion.",
      citations: [
        "docs/design/adr/02-identity-security.md#adr-0080",
        "docs/design/adr/02-identity-security.md#adr-0082"
      ]
    },
    {
      id: "scope-out.public-claim-without-evidence",
      decision: "Do not publish capability, security, support, legal, or compliance claims that lack a source evidence owner.",
      postV1Disposition: "Move to launch limitation, beta-only caveat, or release-blocker queue.",
      citations: [
        "docs/design/vision.md#plan-17",
        "docs/design/governance-planes.md#plan-46",
        "docs/design/adr/02-identity-security.md#adr-0061"
      ]
    },
    {
      id: "scope-out.production-recovery-claim",
      decision: "Do not claim restore, rollback, or upgrade safety without a deterministic drill or dry-run evidence path.",
      postV1Disposition: "Block GA claim or mark beta limitation until evidence is attached.",
      citations: [
        "docs/design/reliability-observability-cost.md#plan-05",
        "docs/design/adr/02-identity-security.md#adr-0047",
        "docs/design/adr/07-portability-extensibility.md#adr-0042"
      ]
    }
  ],
  blockerCategories: [
    {
      id: "v1-blocker.reference-architecture",
      ownerProject: "V1 Release Program & Cutline",
      ownerInitiative: "Launch cutline",
      readinessDomain: "reference-architecture",
      evidenceRequired: ["in-scope decision", "out-of-scope decision", "ADR/design citation"]
    },
    {
      id: "v1-blocker.productization",
      ownerProject: "Workspace & Onboarding UX",
      ownerInitiative: "Productization M0 acceptance",
      readinessDomain: "productization",
      evidenceRequired: ["persona goal", "UX/service boundary", "contract proof path"]
    },
    {
      id: "v1-blocker.support",
      ownerProject: "V1 Launch Support Desk & Escalation",
      ownerInitiative: "Support readiness",
      readinessDomain: "support",
      evidenceRequired: ["severity route", "handoff owner", "customer communication posture"]
    },
    {
      id: "v1-blocker.legal-privacy",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      ownerInitiative: "Customer assurance",
      readinessDomain: "legal-privacy",
      evidenceRequired: ["legal owner", "data class owner", "release blocker or limitation label"]
    },
    {
      id: "v1-blocker.documentation",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      ownerInitiative: "Launch documentation",
      readinessDomain: "documentation",
      evidenceRequired: ["source-of-truth owner", "known limitations", "upgrade/support handoff"]
    },
    {
      id: "v1-blocker.operations-readiness",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      ownerInitiative: "Launch operations proof",
      readinessDomain: "operations-readiness",
      evidenceRequired: ["smoke matrix", "telemetry evidence", "recovery path"]
    }
  ],
  followUpTaskPolicy: {
    createdExecutionTasksBeforeM0Acceptance: false,
    allowedBeforeM0Acceptance: ["scope note", "evidence gap", "owner map", "risk classification"],
    blockedBeforeM0Acceptance: ["M1 implementation task", "M2 implementation task", "M3 hardening task", "M4 GA task"]
  }
};

export const v1CutlineDogfoodAlphaEvidence = {
  schema: "hobo.v1.cutline.m1-dogfood-alpha/2026-06-30",
  issue: "HOBO-454",
  parentIssue: "HOBO-401",
  phase: "M1",
  milestoneGate: "M1 Dogfood/alpha proof",
  decisionStatus: "dogfood-alpha-evidence-accepted",
  requiredEvidence: [
    {
      id: "cutline-baseline",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "src/draft/technical-proofs/v1-cutline-contract",
      proves: "The M0 launch cutline has explicit v1 scope, scope-out, and owner map records.",
      status: "accepted"
    },
    {
      id: "dogfood-alpha-outcome",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      evidenceSource: "docs/design/dogfood-yard.md",
      proves: "Dogfood and alpha outcome evidence can feed the release cutline without becoming GA proof.",
      status: "accepted"
    },
    {
      id: "blocker-delta",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/launch-blocker-taxonomy.md",
      proves: "New, resolved, downgraded, or removed blockers are classified with launch action.",
      status: "accepted"
    },
    {
      id: "accepted-risk-register",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/go-no-go-decision-record.md",
      proves: "Accepted risks have owner, mitigation, launch note or follow-up, and revisit date.",
      status: "accepted"
    },
    {
      id: "cross-project-handoff",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/launch-messaging-claims.md",
      proves: "Release notes, support, legal/privacy, dogfood, and launch messaging inputs stay reflected in the cutline.",
      status: "accepted"
    }
  ],
  blockers: [
    {
      id: "alpha-public-claim-boundary",
      category: "launch-note",
      ownerProject: "V1 Release Program & Cutline",
      sourceEvidenceId: "dogfood-alpha-outcome",
      disposition: "Dogfood/alpha evidence may support private alpha messaging but cannot promote GA operational claims.",
      launchRisk: "medium"
    }
  ],
  acceptedRisks: [
    {
      id: "dogfood-only-support-window",
      ownerRole: "release-owner",
      mitigation: "Keep support and launch language scoped to dogfood/alpha until beta evidence is accepted.",
      followUpOrLaunchNote: "Known limitation in release notes and launch messaging.",
      revisitDate: "2026-07-31",
      evidenceId: "accepted-risk-register"
    }
  ],
  crossProjectDependencies: [
    {
      ownerProject: "V1 Release Notes & Upgrade Guide",
      consumesEvidenceId: "cross-project-handoff",
      cutlineImpact: "Known limitations and release summary consume only accepted cutline evidence."
    },
    {
      ownerProject: "V1 Launch Support Desk & Escalation",
      consumesEvidenceId: "dogfood-alpha-outcome",
      cutlineImpact: "Alpha support commitments stay within approved support channel language."
    },
    {
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      consumesEvidenceId: "accepted-risk-register",
      cutlineImpact: "Legal/privacy unknowns remain blockers or explicit limitations before public launch."
    },
    {
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      consumesEvidenceId: "cross-project-handoff",
      cutlineImpact: "Public claims require state, owner, evidence source, risk, and disposition."
    }
  ],
  missingEvidence: [
    {
      id: "beta-operational-evidence",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      reason: "Dogfood/alpha evidence does not prove beta or GA readiness.",
      launchDisposition: "follow-up"
    }
  ],
  followUpIssues: [
    {
      id: "HOBO-463",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      missingEvidenceId: "beta-operational-evidence",
      allowedReason: "Existing M2 private-beta evidence issue exists because beta operational evidence is missing."
    }
  ],
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness",
    launchRiskChanged: true,
    statusUpdated: true,
    statusUpdateReason: "M1 dogfood/alpha evidence is accepted with beta/GA proof still explicitly missing."
  }
};

export const v1CutlinePrivateBetaEvidence = {
  schema: "hobo.v1.cutline.m2-private-beta/2026-06-30",
  issue: "HOBO-461",
  parentIssue: "HOBO-401",
  phase: "M2",
  milestoneGate: "M2 Private beta proof",
  decisionStatus: "private-beta-evidence-accepted-with-open-follow-ups",
  requiredEvidence: [
    {
      id: "cutline-baseline",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "src/draft/technical-proofs/v1-cutline-contract",
      proves: "The v1 cutline and M1 dogfood/alpha evidence are accepted before private-beta release governance.",
      status: "accepted"
    },
    {
      id: "private-beta-go-no-go",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/go-no-go-decision-record.md",
      proves: "Private-beta decisions name decision inputs, allowed outcomes, accepted-risk owners, and revisit dates.",
      status: "accepted"
    },
    {
      id: "blocker-delta",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/launch-blocker-taxonomy.md",
      proves: "Private-beta blockers and high-risk non-blockers are classified without bypassing required gates.",
      status: "accepted"
    },
    {
      id: "accepted-risk-register",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/go-no-go-decision-record.md",
      proves: "Accepted private-beta risks name owner, mitigation, launch note or follow-up, and revisit date.",
      status: "accepted"
    },
    {
      id: "cross-project-handoff",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/release-notes-upgrade-guide.md",
      proves: "Release notes, support, legal/privacy, dogfood, and beta-pilot evidence owners are reflected in the cutline.",
      status: "accepted"
    }
  ],
  blockers: [
    {
      id: "private-beta-pilot-feedback-open",
      category: "high-risk-non-blocker",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      sourceEvidenceId: "cross-project-handoff",
      disposition: "Private-beta pilot feedback evidence remains tracked by HOBO-463 and cannot be promoted to RC or GA proof.",
      launchRisk: "high"
    },
    {
      id: "private-beta-operations-evidence-open",
      category: "launch-note",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      sourceEvidenceId: "cutline-baseline",
      disposition: "Hosted/self-hosted operations private-beta evidence remains tracked by HOBO-462 before broader operations claims.",
      launchRisk: "medium"
    },
    {
      id: "private-beta-legal-privacy-open",
      category: "high-risk-non-blocker",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      sourceEvidenceId: "accepted-risk-register",
      disposition: "Legal/privacy private-beta evidence remains tracked by HOBO-464 and must stay a limitation until accepted.",
      launchRisk: "high"
    }
  ],
  acceptedRisks: [
    {
      id: "private-beta-limited-evidence-window",
      ownerRole: "release-owner",
      mitigation: "Keep release status conditional on accepted owner evidence and route missing private-beta inputs to existing execution issues.",
      followUpOrLaunchNote: "Private beta may proceed only with explicit limitation text for missing operations, legal/privacy, and beta-feedback evidence.",
      revisitDate: "2026-08-15",
      evidenceId: "accepted-risk-register"
    }
  ],
  crossProjectDependencies: [
    {
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      consumesEvidenceId: "cross-project-handoff",
      cutlineImpact: "Pilot feedback supplies the private-beta customer signal before release-candidate claims."
    },
    {
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      consumesEvidenceId: "cutline-baseline",
      cutlineImpact: "Hosted/self-hosted operations evidence constrains private-beta support and operations claims."
    },
    {
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      consumesEvidenceId: "accepted-risk-register",
      cutlineImpact: "Legal/privacy evidence stays a launch blocker or limitation until the owner accepts it."
    },
    {
      ownerProject: "V1 Release Notes & Upgrade Guide",
      consumesEvidenceId: "cross-project-handoff",
      cutlineImpact: "Release notes list private-beta limitations and unsupported claims from the current cutline."
    },
    {
      ownerProject: "V1 Launch Support Desk & Escalation",
      consumesEvidenceId: "private-beta-go-no-go",
      cutlineImpact: "Support escalation language must match the accepted private-beta decision outcome."
    }
  ],
  missingEvidence: [
    {
      id: "operations-private-beta-evidence",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      reason: "Operations private-beta proof is not part of the release-program cutline package.",
      launchDisposition: "existing-follow-up"
    },
    {
      id: "beta-pilot-feedback-evidence",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      reason: "Pilot feedback proof is owned by the beta project and is already in progress.",
      launchDisposition: "existing-follow-up"
    },
    {
      id: "legal-privacy-private-beta-evidence",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      reason: "Legal/privacy private-beta proof is a separate owner gate.",
      launchDisposition: "existing-follow-up"
    }
  ],
  followUpIssues: [
    {
      id: "HOBO-462",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      missingEvidenceId: "operations-private-beta-evidence",
      allowedReason: "Existing M2 private-beta issue owns hosted/self-hosted operations evidence."
    },
    {
      id: "HOBO-463",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      missingEvidenceId: "beta-pilot-feedback-evidence",
      allowedReason: "Existing M2 private-beta issue owns beta pilot feedback evidence."
    },
    {
      id: "HOBO-464",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      missingEvidenceId: "legal-privacy-private-beta-evidence",
      allowedReason: "Existing M2 private-beta issue owns legal/privacy evidence."
    }
  ],
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness",
    launchRiskChanged: true,
    statusUpdated: true,
    statusUpdateReason: "M2 private-beta release-program evidence is accepted with operations, beta-feedback, and legal/privacy evidence explicitly tracked as existing follow-ups."
  }
};

export const v1CutlineReleaseCandidateEvidence = {
  schema: "hobo.v1.cutline.m3-release-candidate/2026-06-30",
  issue: "HOBO-468",
  parentIssue: "HOBO-401",
  phase: "M3",
  milestoneGate: "M3 Release candidate",
  decisionStatus: "release-candidate-evidence-accepted-with-ga-follow-up",
  requiredEvidence: [
    {
      id: "cutline-baseline",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "src/draft/technical-proofs/v1-cutline-contract",
      proves: "The accepted v1 cutline, M1 dogfood/alpha gate, and M2 private-beta gate form the release-candidate baseline.",
      status: "accepted"
    },
    {
      id: "release-candidate-go-no-go",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/go-no-go-decision-record.md",
      proves: "Release-candidate decisions name inputs, allowed outcomes, blocker deltas, accepted-risk owners, and revisit dates.",
      status: "accepted"
    },
    {
      id: "blocker-delta",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/launch-blocker-taxonomy.md",
      proves: "M3 blockers, high-risk non-blockers, launch notes, and post-GA follow-ups are classified without waiving gates.",
      status: "accepted"
    },
    {
      id: "accepted-risk-register",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/go-no-go-decision-record.md#risk-acceptance-rules",
      proves: "Accepted release-candidate risks carry owner, mitigation, launch note or follow-up, and revisit date.",
      status: "accepted"
    },
    {
      id: "cross-project-handoff",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/launch-messaging-claims.md",
      proves: "Release notes, support, legal/privacy, dogfood operations, launch-site messaging, and beta feedback consume only owner-mapped evidence.",
      status: "accepted"
    },
    {
      id: "release-notes-readiness",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      evidenceSource: "docs/design/release-notes-upgrade-guide.md",
      proves: "Release notes consume release-candidate evidence without drafting final notes or promoting GA claims.",
      status: "accepted"
    }
  ],
  blockers: [
    {
      id: "owner-m3-gates-still-independent",
      category: "high-risk-non-blocker",
      ownerProject: "V1 Release Program & Cutline",
      sourceEvidenceId: "cross-project-handoff",
      disposition: "The cutline can record M3 release-candidate routing, but owner gates for release notes, legal/privacy, launch site, support, beta, and operations remain independently reviewable.",
      launchRisk: "medium"
    },
    {
      id: "ga-handoff-not-yet-proven",
      category: "launch-blocker",
      ownerProject: "V1 Release Program & Cutline",
      sourceEvidenceId: "release-candidate-go-no-go",
      disposition: "GA readiness stays blocked until HOBO-475 records release-program GA handoff evidence.",
      launchRisk: "high"
    }
  ],
  acceptedRisks: [
    {
      id: "release-candidate-with-open-owner-gates",
      ownerRole: "release-owner",
      mitigation: "Keep release-candidate status conditional on each owner lane's accepted evidence and list unresolved owner gates as launch notes or blockers.",
      followUpOrLaunchNote: "Release notes and launch messaging must call out owner-gate status instead of implying final launch readiness.",
      revisitDate: "2026-08-31",
      evidenceId: "accepted-risk-register"
    },
    {
      id: "rc-not-ga-claim-boundary",
      ownerRole: "release-owner",
      mitigation: "Use release-candidate language only; GA/public launch claims require the M4 handoff issue and owner signoff.",
      followUpOrLaunchNote: "Known limitation in launch messaging until HOBO-475 is accepted.",
      revisitDate: "2026-09-15",
      evidenceId: "release-candidate-go-no-go"
    }
  ],
  crossProjectDependencies: [
    {
      ownerProject: "V1 Release Notes & Upgrade Guide",
      consumesEvidenceId: "release-notes-readiness",
      cutlineImpact: "Release notes may summarize accepted RC evidence and must keep unresolved owner gates visible."
    },
    {
      ownerProject: "V1 Launch Support Desk & Escalation",
      consumesEvidenceId: "cross-project-handoff",
      cutlineImpact: "Support readiness consumes RC owner state without promising GA support targets."
    },
    {
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      consumesEvidenceId: "accepted-risk-register",
      cutlineImpact: "Legal/privacy findings remain blockers, high-risk non-blockers, or limitations until owner evidence is accepted."
    },
    {
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      consumesEvidenceId: "cutline-baseline",
      cutlineImpact: "Dogfood and hosted operations evidence bounds operational claims before GA handoff."
    },
    {
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      consumesEvidenceId: "cross-project-handoff",
      cutlineImpact: "Launch messaging consumes only evidence-backed claims and keeps RC separate from GA."
    },
    {
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      consumesEvidenceId: "release-candidate-go-no-go",
      cutlineImpact: "Beta feedback informs release-candidate go/no-go without becoming GA customer proof."
    }
  ],
  missingEvidence: [
    {
      id: "release-program-ga-handoff",
      ownerProject: "V1 Release Program & Cutline",
      reason: "M3 release-candidate evidence does not prove final GA handoff readiness.",
      launchDisposition: "existing-follow-up"
    }
  ],
  followUpIssues: [
    {
      id: "HOBO-475",
      ownerProject: "V1 Release Program & Cutline",
      missingEvidenceId: "release-program-ga-handoff",
      allowedReason: "Existing M4 GA handoff issue owns final release-program GA evidence."
    }
  ],
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness",
    launchRiskChanged: true,
    statusUpdated: true,
    statusUpdateReason: "M3 release-candidate release-program evidence is accepted with GA handoff still explicitly missing and tracked by HOBO-475."
  },
  scopeOut: [
    "Do not publish public GA, general availability, or final launch claims from M3 release-candidate evidence.",
    "Do not implement release automation, approval UI, customer-facing release notes, support tooling, legal text, or runtime launch gates in this proof."
  ],
  publicClaimGuards: [
    {
      id: "rc-is-not-ga",
      claim: "Release-candidate evidence proves only RC cutline readiness, not GA readiness.",
      evidenceId: "release-candidate-go-no-go",
      disposition: "hold"
    }
  ]
};

export const v1CutlineGaHandoffEvidence = {
  schema: "hobo.v1.cutline.m4-ga-handoff/2026-06-30",
  issue: "HOBO-475",
  parentIssue: "HOBO-401",
  phase: "M4",
  milestoneGate: "M4 GA handoff",
  decisionStatus: "ga-handoff-evidence-accepted-with-dependent-m4-blockers",
  requiredEvidence: [
    {
      id: "cutline-baseline",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "src/draft/technical-proofs/v1-cutline-contract",
      proves: "The accepted M0 cutline and M1-M3 release-program gates form the GA handoff baseline.",
      status: "accepted"
    },
    {
      id: "ga-go-no-go",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/go-no-go-decision-record.md#gate-workflow",
      proves: "GA decisions consume signed launch checklist, support handoff, legal/privacy posture, blocker delta, and evidence links.",
      status: "accepted"
    },
    {
      id: "signed-launch-checklist",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/v1-readiness-dashboard.md#required-fields",
      proves: "Release readiness fields name owners, evidence links, blockers, accepted risks, and last verification state before a GA decision.",
      status: "accepted"
    },
    {
      id: "support-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      evidenceSource: "docs/design/support-sla-channels.md#support-sla-language",
      proves: "Support handoff language, severity routing, launch-room limits, and release-cutline escalation remain owner-scoped.",
      status: "accepted"
    },
    {
      id: "legal-privacy-posture",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      evidenceSource: "docs/design/proofs/hobo-478-legal-privacy-ga-handoff/index.md",
      proves: "Legal/privacy GA handoff evidence is accepted without drafting legal text or expanding compliance claims.",
      status: "accepted"
    },
    {
      id: "blocker-delta",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/launch-blocker-taxonomy.md",
      proves: "GA blockers, high-risk non-blockers, launch notes, and post-GA follow-ups are classified without waiving gates.",
      status: "accepted"
    },
    {
      id: "accepted-risk-register",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/go-no-go-decision-record.md#risk-acceptance-rules",
      proves: "Accepted GA risks carry owner, mitigation, launch note or follow-up, revisit date, and supporting evidence.",
      status: "accepted"
    },
    {
      id: "cross-project-handoff",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/traceability.md",
      proves: "Release notes, support, legal/privacy, dogfood operations, launch-site messaging, and beta-pilot owner lanes stay reflected in the cutline.",
      status: "accepted"
    },
    {
      id: "readiness-dashboard-refresh",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/v1-readiness-dashboard.md#source-of-truth-rules",
      proves: "Readiness dashboard status fails closed on missing evidence, unknown blockers, absent owners, or stale verification.",
      status: "accepted"
    }
  ],
  blockers: [
    {
      id: "open-dogfood-ga-handoff",
      category: "launch-blocker",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      sourceEvidenceId: "cross-project-handoff",
      disposition: "HOBO-476 remains the visible M4 Dogfood Yard and Hosted Operations GA handoff blocker before public GA claims can publish.",
      launchRisk: "high"
    },
    {
      id: "open-beta-pilot-ga-handoff",
      category: "launch-blocker",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      sourceEvidenceId: "cross-project-handoff",
      disposition: "HOBO-477 remains the visible M4 Beta Pilot and Feedback Loop GA handoff blocker before public GA claims can publish.",
      launchRisk: "high"
    },
    {
      id: "ga-public-claim-held",
      category: "launch-note",
      ownerProject: "V1 Release Program & Cutline",
      sourceEvidenceId: "ga-go-no-go",
      disposition: "The release-program GA record can be accepted, but customer-facing GA publication stays held until dependent M4 owner handoffs close.",
      launchRisk: "medium"
    }
  ],
  acceptedRisks: [
    {
      id: "release-program-ga-record-with-dependent-blockers",
      ownerRole: "release-owner",
      mitigation: "Keep the parent readiness status and launch messaging conditional on HOBO-476 and HOBO-477 until their owner evidence is accepted.",
      followUpOrLaunchNote: "Readiness dashboard and release notes must show Dogfood Yard and Beta Pilot M4 handoffs as open launch blockers.",
      revisitDate: "2026-09-30",
      evidenceId: "accepted-risk-register"
    }
  ],
  crossProjectDependencies: [
    {
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      consumesEvidenceId: "cross-project-handoff",
      cutlineImpact: "Hosted operations GA evidence blocks public operational readiness claims until HOBO-476 lands."
    },
    {
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      consumesEvidenceId: "cross-project-handoff",
      cutlineImpact: "Beta feedback GA evidence blocks broad customer-readiness claims until HOBO-477 lands."
    },
    {
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      consumesEvidenceId: "legal-privacy-posture",
      cutlineImpact: "Legal/privacy owner evidence may be consumed only as accepted posture, not as legal text or expanded compliance claims."
    },
    {
      ownerProject: "V1 Launch Support Desk & Escalation",
      consumesEvidenceId: "support-handoff",
      cutlineImpact: "Support handoff language constrains launch-room, severity, and customer communication commitments."
    },
    {
      ownerProject: "V1 Release Notes & Upgrade Guide",
      consumesEvidenceId: "ga-go-no-go",
      cutlineImpact: "Release notes must list open M4 owner handoffs and cannot imply GA readiness while blockers remain."
    },
    {
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      consumesEvidenceId: "readiness-dashboard-refresh",
      cutlineImpact: "Launch-site claims consume readiness-dashboard state and stay held when blockers, missing evidence, or stale verification are red."
    }
  ],
  missingEvidence: [
    {
      id: "dogfood-yard-ga-handoff",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      reason: "Dogfood Yard and hosted operations M4 handoff evidence is a separate visible Backlog issue.",
      launchDisposition: "existing-follow-up"
    },
    {
      id: "beta-pilot-ga-handoff",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      reason: "Beta pilot and feedback-loop M4 handoff evidence is a separate visible Backlog issue.",
      launchDisposition: "existing-follow-up"
    }
  ],
  followUpIssues: [
    {
      id: "HOBO-476",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      missingEvidenceId: "dogfood-yard-ga-handoff",
      allowedReason: "Existing M4 Backlog issue owns Dogfood Yard and Hosted Operations GA handoff evidence."
    },
    {
      id: "HOBO-477",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      missingEvidenceId: "beta-pilot-ga-handoff",
      allowedReason: "Existing M4 Backlog issue owns Beta Pilot and Feedback Loop GA handoff evidence."
    }
  ],
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness",
    launchRiskChanged: true,
    statusUpdated: true,
    statusUpdateReason: "M4 release-program GA handoff evidence is accepted with Dogfood Yard and Beta Pilot handoffs still recorded as visible launch blockers."
  },
  scopeOut: [
    "Do not implement release automation, approval UI, runtime launch gates, support tooling, customer-facing release notes, or legal text in this proof.",
    "Do not publish public GA or general availability claims while HOBO-476 or HOBO-477 remain open.",
    "Do not create new follow-up execution work unless the record names missing evidence and an owner lane."
  ],
  publicClaimGuards: [
    {
      id: "ga-held-until-owner-handoffs-close",
      claim: "GA publication waits for Dogfood Yard and Beta Pilot M4 handoff evidence.",
      evidenceId: "ga-go-no-go",
      disposition: "hold"
    }
  ]
};

export function validateV1Cutline(record) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["cutline record is required"] };
  }

  for (const collectionName of ["inScope", "outOfScope", "blockerCategories"]) {
    if (!Array.isArray(record[collectionName]) || record[collectionName].length === 0) {
      errors.push(`${collectionName} must be a non-empty list`);
    }
  }

  for (const item of record.inScope ?? []) {
    if (!item.id || !item.decision || !item.ownerProject) {
      errors.push(`in-scope item ${item.id ?? "<missing>"} must have id, decision, and ownerProject`);
    }
    if (item.workKind === "capability-implementation") {
      errors.push(`${item.id}: capability implementation is scope-out for HOBO-401`);
    }
  }

  for (const item of record.outOfScope ?? []) {
    if (!item.id || !item.decision || !item.postV1Disposition) {
      errors.push(`scope-out item ${item.id ?? "<missing>"} must have id, decision, and postV1Disposition`);
    }
    if (!Array.isArray(item.citations) || item.citations.length === 0) {
      errors.push(`${item.id ?? "<missing>"} must cite design docs or ADRs`);
    }
  }

  const represented = new Set([
    ...(record.inScope ?? []).map((item) => item.readinessDomain),
    ...(record.blockerCategories ?? []).map((item) => item.readinessDomain)
  ]);
  for (const domain of REQUIRED_READINESS_DOMAINS) {
    if (!represented.has(domain)) {
      errors.push(`${domain} readiness domain is not represented`);
    }
  }

  for (const category of record.blockerCategories ?? []) {
    if (!category.id?.startsWith("v1-blocker.")) {
      errors.push(`${category.id ?? "<missing>"} must be a v1-blocker category`);
    }
    if (!category.ownerProject || !category.ownerInitiative) {
      errors.push(`${category.id ?? "<missing>"} must map to ownerProject and ownerInitiative`);
    }
    if (!Array.isArray(category.evidenceRequired) || category.evidenceRequired.length === 0) {
      errors.push(`${category.id ?? "<missing>"} must name required evidence`);
    }
  }

  if (record.followUpTaskPolicy?.createdExecutionTasksBeforeM0Acceptance) {
    errors.push("M1-M4 execution tasks require accepted M0 criteria");
  }

  return { ok: errors.length === 0, errors };
}

export function validateDogfoodAlphaEvidence(record) {
  return validateReleaseGateEvidence(record, {
    recordName: "dogfood alpha evidence record",
    issue: "HOBO-454",
    phase: "M1",
    milestoneGate: "M1 Dogfood/alpha proof",
    requiredEvidenceIds: REQUIRED_DOGFOOD_ALPHA_EVIDENCE_IDS,
    requiredEvidenceLabel: "M1",
    gateName: "M1 dogfood/alpha"
  });
}

export function validatePrivateBetaEvidence(record) {
  return validateReleaseGateEvidence(record, {
    recordName: "private beta evidence record",
    issue: "HOBO-461",
    phase: "M2",
    milestoneGate: "M2 Private beta proof",
    requiredEvidenceIds: REQUIRED_PRIVATE_BETA_EVIDENCE_IDS,
    requiredEvidenceLabel: "M2",
    gateName: "M2 private beta"
  });
}

export function validateReleaseCandidateEvidence(record) {
  const result = validateReleaseGateEvidence(record, {
    recordName: "release candidate evidence record",
    issue: "HOBO-468",
    phase: "M3",
    milestoneGate: "M3 Release candidate",
    requiredEvidenceIds: REQUIRED_RELEASE_CANDIDATE_EVIDENCE_IDS,
    requiredEvidenceLabel: "M3",
    gateName: "M3 release candidate"
  });
  const errors = [...result.errors];

  for (const guard of record?.publicClaimGuards ?? []) {
    if (!guard.id || !guard.claim || !guard.evidenceId || !guard.disposition) {
      errors.push(`${guard.id ?? "<missing>"} public claim guard must name id, claim, evidenceId, and disposition`);
      continue;
    }
    if (guard.disposition === "publish" && /\bGA\b|\bgeneral availability\b/i.test(guard.claim)) {
      errors.push(`${guard.id}: GA claims require GA handoff evidence`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateGaHandoffEvidence(record) {
  const result = validateReleaseGateEvidence(record, {
    recordName: "GA handoff evidence record",
    issue: "HOBO-475",
    phase: "M4",
    milestoneGate: "M4 GA handoff",
    requiredEvidenceIds: REQUIRED_GA_HANDOFF_EVIDENCE_IDS,
    requiredEvidenceLabel: "M4",
    gateName: "M4 GA handoff"
  });
  const errors = [...result.errors];

  for (const guard of record?.publicClaimGuards ?? []) {
    if (!guard.id || !guard.claim || !guard.evidenceId || !guard.disposition) {
      errors.push(`${guard.id ?? "<missing>"} public claim guard must name id, claim, evidenceId, and disposition`);
      continue;
    }
    const hasOpenHandoffDependency = (record.missingEvidence?.length ?? 0) > 0
      || (record.blockers ?? []).some((blocker) => blocker.category === "launch-blocker");
    if (guard.disposition === "publish" && /\bGA\b|\bgeneral availability\b/i.test(guard.claim) && hasOpenHandoffDependency) {
      errors.push(`${guard.id}: GA publication requires every M4 handoff dependency to be closed`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateReleaseGateEvidence(record, config) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: [`${config.recordName} is required`] };
  }

  if (record.issue !== config.issue) {
    errors.push(`issue must be ${config.issue}`);
  }
  if (record.phase !== config.phase) {
    errors.push(`phase must be ${config.phase}`);
  }
  if (record.milestoneGate !== config.milestoneGate) {
    errors.push(`milestone gate must be ${config.milestoneGate}`);
  }

  const evidenceIds = new Set((record.requiredEvidence ?? []).map((item) => item.id));
  for (const evidenceId of config.requiredEvidenceIds) {
    if (!evidenceIds.has(evidenceId)) {
      errors.push(`missing required ${config.requiredEvidenceLabel} evidence: ${evidenceId}`);
    }
  }
  for (const evidence of record.requiredEvidence ?? []) {
    if (!evidence.ownerProject || !evidence.evidenceSource || !evidence.proves) {
      errors.push(`${evidence.id ?? "<missing>"} must map evidence to ownerProject, evidenceSource, and proof statement`);
    }
    if (evidence.status !== "accepted") {
      errors.push(`${evidence.id ?? "<missing>"} must be accepted before the ${config.gateName} gate can pass`);
    }
  }

  if (!Array.isArray(record.blockers) || record.blockers.length === 0) {
    errors.push("blockers must be recorded, even when they are launch notes or non-blockers");
  }
  for (const blocker of record.blockers ?? []) {
    if (!blocker.id || !blocker.category || !blocker.ownerProject || !blocker.sourceEvidenceId || !blocker.disposition) {
      errors.push(`${blocker.id ?? "<missing>"} blocker must name category, ownerProject, sourceEvidenceId, and disposition`);
    }
    if (blocker.sourceEvidenceId && !evidenceIds.has(blocker.sourceEvidenceId)) {
      errors.push(`${blocker.id ?? "<missing>"} blocker cites unknown evidence ${blocker.sourceEvidenceId}`);
    }
  }

  if (!Array.isArray(record.acceptedRisks) || record.acceptedRisks.length === 0) {
    errors.push("accepted risks must be recorded");
  }
  for (const risk of record.acceptedRisks ?? []) {
    if (!risk.id || !risk.ownerRole || !risk.mitigation || !risk.followUpOrLaunchNote || !risk.revisitDate) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk must name ownerRole, mitigation, followUpOrLaunchNote, and revisitDate`);
    }
    if (risk.evidenceId && !evidenceIds.has(risk.evidenceId)) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk cites unknown evidence ${risk.evidenceId}`);
    }
  }

  if (!Array.isArray(record.crossProjectDependencies) || record.crossProjectDependencies.length === 0) {
    errors.push("cross-project dependencies must be reflected in the cutline");
  }
  for (const dependency of record.crossProjectDependencies ?? []) {
    if (!dependency.ownerProject || !dependency.consumesEvidenceId || !dependency.cutlineImpact) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency must name ownerProject, consumesEvidenceId, and cutlineImpact`);
    }
    if (dependency.consumesEvidenceId && !evidenceIds.has(dependency.consumesEvidenceId)) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency cites unknown evidence ${dependency.consumesEvidenceId}`);
    }
  }

  const missingEvidenceIds = new Set((record.missingEvidence ?? []).map((item) => item.id));
  for (const followUp of record.followUpIssues ?? []) {
    if (!followUp.id || !followUp.ownerProject || !followUp.missingEvidenceId || !followUp.allowedReason) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up must name ownerProject, missingEvidenceId, and allowedReason`);
    }
    if (followUp.missingEvidenceId && !missingEvidenceIds.has(followUp.missingEvidenceId)) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up is allowed only for missing evidence`);
    }
  }

  if (record.parentInitiativeSync?.launchRiskChanged && !record.parentInitiativeSync.statusUpdated) {
    errors.push("parent initiative status must be updated when launch risk changes");
  }

  return { ok: errors.length === 0, errors };
}

export function assertV1Cutline(record = v1Cutline) {
  const result = validateV1Cutline(record);

  if (!result.ok) {
    throw new Error(`v1 cutline contract invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}

package vibe_troubleshooting_decision_trees

#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"
#PathState: "happy" | "blocked" | "stale-or-unknown" | "support-handoff"

#RedactionEvidence: {
  redacted: true
  visibleFields: [...string] & [_, ...]
  withheldFields: [...string] & [_, ...]
}

#TroubleshootingDecisionCase: {
  caseId: string
  pathState: #PathState
  symptom: string
  diagnosticEvidence: [...string] & [_, ...]
  owner: string
  safeNextAction: string
  customerSafeWording: string
  escalationRoute: string
  proofMode: #ProofMode
  quickstartFixtureRefs: [...string] & [_, ...]
  accessibilityNotes: [...string] & [_, ...]
  redaction: #RedactionEvidence
}

#VibeTroubleshootingDecisionTrees: {
  issue: "HOBO-553"
  phase: "M1"
  targetPackage: "src/draft/exp-proofs/ux/vibe-troubleshooting-decision-trees"
  proofNote: "docs/design/proofs/vibe-troubleshooting-decision-trees/README.md"
  designRefs: [...string] & [_, ...]
  proofModes: ["live", "simulated", "reference fixture", "scope-out"]
  cases: [...#TroubleshootingDecisionCase] & [_, ...]
  scopeOut: [...string] & [_, ...]
}

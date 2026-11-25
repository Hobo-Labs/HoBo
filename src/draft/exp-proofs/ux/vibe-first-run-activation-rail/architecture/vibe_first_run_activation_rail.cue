package vibe_first_run_activation_rail

#ProofMode: "live" | "simulated" | "reference-fixture" | "scope-out"
#EntryPoint: "app-developer" | "team-admin" | "platform-engineer" | "support-operator"
#Stage: "invite-or-try-it" | "workspace" | "project" | "plan-preview" | "launch-attempt" | "recovery" | "value-proof"
#Outcome: "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
#FixtureId: =~"^rlq-[a-z0-9-]+-v[0-9]+$"
#EvidenceObject: =~"^[a-z]+(\\.[a-z-]+)+$"

#ActivationRailWireframe: {
  entryPoint: #EntryPoint
  primaryQuestion: string & !=""
  visibleStates: [...#Stage]
  nextAction: string & !=""
  accessibilityNotes: [...string] & len(_) >= 2
}

#ActivationRailState: {
  stage: #Stage
  entryCondition: string & !=""
  exitCondition: string & !=""
  owner: string & !=""
  evidenceObject: #EvidenceObject
  missingPrerequisiteBehavior: string & !=""
  proofMode: #ProofMode
  quickstartFixtureIds: [...#FixtureId] & len(_) > 0
}

#ActivationRailOutcome: {
  kind: #Outcome
  title: string & !=""
  userMessage: string & !=""
  owner: string & !=""
  proofMode: #ProofMode
  quickstartFixtureIds: [...#FixtureId] & len(_) > 0
}

#ActivationRailProofModeLegend: {
  proofMode: #ProofMode
  label: string & !=""
  meaning: string & !=""
}

#VibeFirstRunActivationRail: {
  issue: "HOBO-540"
  phase: "M1"
  targetPackage: "src/draft/exp-proofs/ux/vibe-first-run-activation-rail"
  proofNote: "docs/design/proofs/vibe-first-run-activation-rail/README.md"
  designRefs: [...string] & len(_) > 0
  scopeOut: [...string] & len(_) >= 5
  wireframes: [...#ActivationRailWireframe]
  stateModel: [...#ActivationRailState]
  outcomes: [...#ActivationRailOutcome]
  proofModeLegend: [...#ActivationRailProofModeLegend]
}

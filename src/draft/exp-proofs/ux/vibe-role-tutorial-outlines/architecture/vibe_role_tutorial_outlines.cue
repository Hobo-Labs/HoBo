package vibe_role_tutorial_outlines

#Role: "app developer" | "platform engineer" | "GitOps" | "SecOps" | "DevOps" | "SRE"
#CoveragePath: "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"
#QuickstartProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"
#QuickstartFixtureId: "rlq-define-object-graph-v1" | "rlq-collect-manifest-ir-v1" | "rlq-plan-safe-preview-v1" | "rlq-deploy-run-accepted-v1" | "rlq-inspect-event-projection-v1" | "rlq-manage-stale-evidence-v1" | "rlq-migrate-brownfield-preview-v1" | "rlq-recover-snapshot-restore-v1" | "rlq-recover-scope-out-v1"
#NonEmptyString: string & !=""
#NonEmptyStringList: [#NonEmptyString, ...#NonEmptyString]

#TutorialQuickstartFixtureRef: {
	sourceIssue: "HOBO-577"
	fixtureId: #QuickstartFixtureId
	proofMode: #QuickstartProofMode
	tutorialUse: #NonEmptyString
}

#TutorialCoverage: {
	id: #CoveragePath
	evidence: #NonEmptyString
	outlineRoles: [#Role, ...#Role]
}

#RoleTutorialOutline: {
	role: #Role
	walkthroughAnchor: =~"^urn:hobo:requirement:walkthrough#"
	personaGoal: #NonEmptyString
	prerequisites: #NonEmptyStringList
	commandPath: #NonEmptyStringList
	mcpTools: #NonEmptyStringList
	fixtureStrategy: #NonEmptyString
	expectedOutputs: #NonEmptyStringList
	failureBranch: #NonEmptyString
	proofModeLabels: [#ProofMode, ...#ProofMode]
	quickstartFixtureIds: [#QuickstartFixtureId, ...#QuickstartFixtureId]
	accessibilityNotes: #NonEmptyStringList
	supportHandoff: #NonEmptyString
}

#VibeRoleTutorialOutlines: {
	issue: "HOBO-552"
	phase: "M1"
	packagePath: "src/draft/exp-proofs/ux/vibe-role-tutorial-outlines"
	proofPath: "urn:hobo:proof:vibe-role-tutorial-outlines"
	designRefs: #NonEmptyStringList
	roles: [#Role, ...#Role]
	quickstartFixtureRefs: [#TutorialQuickstartFixtureRef, ...#TutorialQuickstartFixtureRef]
	coveragePaths: [#TutorialCoverage, ...#TutorialCoverage]
	outlines: [#RoleTutorialOutline, ...#RoleTutorialOutline]
	scopeOut: #NonEmptyStringList
}

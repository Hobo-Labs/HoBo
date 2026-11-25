// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#VibeSupportWorkflowProofMode: "live" | "simulated" | "reference fixture" | "scope-out"

#NonEmptyStringList: [string, ...string]

#VibeSupportWorkflowMockupState: "received" | "classified" | "evidence-linked" | "owner-routed" | "customer-updated" | "closed"

#VibeSupportWorkflowMockup: {
	id:                string & !=""
	state:             #VibeSupportWorkflowMockupState
	title:             string & !=""
	personas:          #NonEmptyStringList
	questionsAnswered: #NonEmptyStringList
	fixtureIds:        #NonEmptyStringList
}

#VibeSupportWorkflowFixture: {
	id:                    string & !=""
	requester:             string & !=""
	customerSafeSummary:   string & !=""
	severity:              "SEV0" | "SEV1" | "SEV2" | "SEV3"
	affectedSurface:       string & !=""
	ownerRoute:            string & !=""
	evidenceLinks:         #NonEmptyStringList
	redactionState:        "customer-safe" | "internal-only" | "requires-security-approval" | "scope-out"
	nextUpdateCondition:   string & !=""
	proofMode:             #VibeSupportWorkflowProofMode
}

#VibeSupportWorkflowScenarioPath: {
	id:          "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
	narrative:   string & !=""
	fixtureIds:  #NonEmptyStringList
	safeOutcome: string & !=""
}

#VibeSupportWorkflowQuickstartFixtureReference: {
	sourceIssue: "HOBO-577"
	fixtureId:   "rlq-deploy-run-accepted-v1" | "rlq-manage-stale-evidence-v1" | "rlq-recover-snapshot-restore-v1" | "rlq-recover-scope-out-v1"
	proofMode:   "reference-fixture" | "simulated" | "live" | "scope-out"
	supportUse:  string & !=""
}

#VibeSupportWorkflowMockupsRecord: {
	issue:                   "HOBO-550"
	phase:                   "M1"
	packagePath:             "src/draft/exp-proofs/ux/vibe-support-workflow-mockups"
	proofPath:               "docs/design/proofs/vibe-support-workflow-mockups/README.md"
	designRefs:              #NonEmptyStringList
	quickstartFixtureRefs:   [#VibeSupportWorkflowQuickstartFixtureReference, ...#VibeSupportWorkflowQuickstartFixtureReference]
	personas:                #NonEmptyStringList
	mockups:                 [#VibeSupportWorkflowMockup, ...#VibeSupportWorkflowMockup]
	fixtures:                [#VibeSupportWorkflowFixture, ...#VibeSupportWorkflowFixture]
	scenarioPaths:           [#VibeSupportWorkflowScenarioPath, ...#VibeSupportWorkflowScenarioPath]
	accessibilityNotes:      #NonEmptyStringList
	scopeOut:                #NonEmptyStringList
}

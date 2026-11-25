
package architecture_evidence

#VibePublisherPortalProofMode: "live" | "simulated" | "reference fixture" | "scope-out"

#VibePublisherPortalQuickstartProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"

#NonEmptyStringList: [string, ...string]

#VibePublisherPortalState: "submission-draft" | "evidence-upload" | "review-status" | "rejection-remediation" | "resubmission" | "yank-remediation" | "payout-support-handoff"

#VibePublisherPortalMockup: {
	id:                string & !=""
	state:             #VibePublisherPortalState
	title:             string & !=""
	personas:          #NonEmptyStringList
	questionsAnswered: #NonEmptyStringList
	fixtureIds:        #NonEmptyStringList
}

#VibePublisherPortalFixture: {
	id:                        string & !=""
	artifactMetadata:          string & !=""
	evidenceState:             string & !=""
	reviewOutcome:             string & !=""
	payoutReadinessHandoff:    string & !=""
	supportWording:            string & !=""
	customerVisibleLimitation: string & !=""
	proofMode:                 #VibePublisherPortalProofMode
}

#VibePublisherPortalScenarioPath: {
	id:          "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
	narrative:   string & !=""
	fixtureIds:  #NonEmptyStringList
	safeOutcome: string & !=""
}

#VibePublisherPortalQuickstartFixtureReference: {
	sourceIssue:  "HOBO-577"
	fixtureId:    "rlq-define-object-graph-v1" | "rlq-collect-manifest-ir-v1" | "rlq-manage-stale-evidence-v1" | "rlq-recover-snapshot-restore-v1" | "rlq-recover-scope-out-v1"
	proofMode:    #VibePublisherPortalQuickstartProofMode
	publisherUse: string & !=""
}

#VibePublisherPortalReviewMockupsRecord: {
	issue:                 "HOBO-548"
	phase:                 "M1"
	packagePath:           "src/draft/exp-proofs/ux/vibe-publisher-portal-review-mockups"
	proofPath:             "https://linear.app/quickdeploy-ai/document/hobo-548-vibe-publisher-portal-review-mockups-proof-archived-ccb8a2907844"
	designRefs:            #NonEmptyStringList
	quickstartFixtureRefs: [#VibePublisherPortalQuickstartFixtureReference, ...#VibePublisherPortalQuickstartFixtureReference]
	personas:              #NonEmptyStringList
	mockups:               [#VibePublisherPortalMockup, ...#VibePublisherPortalMockup]
	fixtures:              [#VibePublisherPortalFixture, ...#VibePublisherPortalFixture]
	scenarioPaths:         [#VibePublisherPortalScenarioPath, ...#VibePublisherPortalScenarioPath]
	accessibilityNotes:    #NonEmptyStringList
	scopeOut:              #NonEmptyStringList
}

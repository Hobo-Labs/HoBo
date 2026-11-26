package vibe_plan_diff_review_prototype

#Issue: "HOBO-560"
#SourceIssue: "HOBO-542" | "HOBO-543" | "HOBO-577"
#GoldenState: "create" | "update" | "no-op" | "destructive" | "blocked" | "stale" | "unknown-evidence"
#Surface: "plan-summary" | "change-diff" | "risk-policy" | "cost-capacity" | "approval-support"
#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"
#QuickstartFixtureId: "rlq-plan-safe-preview-v1" | "rlq-manage-stale-evidence-v1" | "rlq-migrate-brownfield-preview-v1" | "rlq-recover-snapshot-restore-v1"
#NonEmptyString: string & != ""

#SourceDependency: {
	issue:    #SourceIssue
	title:    #NonEmptyString
	status:   "accepted"
	evidence: #NonEmptyString
}

#AnnotationRef: {
	sourceIssue:    "HOBO-543"
	fixtureId:      #NonEmptyString
	annotationCase: #NonEmptyString
	displayGroup:   #NonEmptyString
	severity:       #NonEmptyString
	proofMode:      #NonEmptyString
}

#SupportHandoff: {
	issue:               #Issue
	sourceIssue:         #SourceIssue
	correlationId:       #NonEmptyString
	customerSafeWording: #NonEmptyString
	visibleFields:       [...string]
	withheldFields:      [...string]
	ownerRoute:          #NonEmptyString
	nextAction:          #NonEmptyString
	liveTicketCreated:   false
}

#GoldenFixture: {
	state:                #GoldenState
	surface:              #Surface
	sourceIssue:          #SourceIssue
	sourceFixtureId:      #NonEmptyString
	planReviewStateId:    #GoldenState
	evidenceSource:       #NonEmptyString
	owner:                #NonEmptyString
	safeNextAction:       =~".*(approve|review|block|wait|handoff|revise).*"
	riskCategory:         #NonEmptyString
	policyDisposition:    #NonEmptyString
	costDisposition:      #NonEmptyString
	capacityDisposition:  #NonEmptyString
	customerSafeWording:  #NonEmptyString
	proofMode:            #ProofMode
	annotationRefs:       [#AnnotationRef, ...#AnnotationRef]
	supportHandoff:       #SupportHandoff
}

#Scenario: {
	id:               "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
	title:            #NonEmptyString
	goldenStates:     [...#GoldenState]
	proofModeLabels:  [...#ProofMode]
	safeOutcome:      #NonEmptyString
}

#QuickstartFixtureRef: {
	sourceIssue:      "HOBO-577"
	fixtureId:        #QuickstartFixtureId
	proofMode:        "reference-fixture" | "simulated" | "live" | "scope-out"
	consumingSurface: #Surface
	planDiffUse:      #NonEmptyString
}

#Prototype: {
	issue:                 #Issue
	phase:                 "M2"
	targetPackage:         "src/draft/exp-proofs/ux/vibe-plan-diff-review-prototype"
	proofNote:             "docs/design/proofs/vibe-plan-diff-review-prototype/README.md"
	sourceDependencies:    [#SourceDependency, ...#SourceDependency]
	quickstartFixtureRefs: [#QuickstartFixtureRef, ...#QuickstartFixtureRef]
	goldenFixtures:        [#GoldenFixture, ...#GoldenFixture]
	scenarios:             [#Scenario, ...#Scenario]
	accessibilityNotes:    [#NonEmptyString, ...#NonEmptyString]
	scopeOut:              [#NonEmptyString, ...#NonEmptyString]
}

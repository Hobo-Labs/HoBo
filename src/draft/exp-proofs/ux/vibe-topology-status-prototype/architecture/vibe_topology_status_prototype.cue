package vibe_topology_status_prototype

#Issue: "HOBO-561"
#SourceIssue: "HOBO-544" | "HOBO-545" | "HOBO-577"
#State: "fresh" | "stale" | "unavailable" | "redacted" | "unauthorized" | "partial" | "failed" | "rolled-back" | "completed"
#Surface: "deployment-timeline" | "topology-graph" | "run-inspector" | "freshness-rbac-state" | "support-handoff"
#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"
#QuickstartFixtureId: "rlq-deploy-run-accepted-v1" | "rlq-inspect-event-projection-v1" | "rlq-manage-stale-evidence-v1" | "rlq-recover-snapshot-restore-v1" | "rlq-recover-scope-out-v1"
#QuickstartProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"
#NonEmptyString: string & != ""
#NonEmptyStringList: [#NonEmptyString, ...#NonEmptyString]

#SourceDependency: {
	issue:       #SourceIssue
	title:       #NonEmptyString
	status:      "accepted"
	evidence:    #NonEmptyString
}

#QuickstartFixtureRef: {
	sourceIssue:      "HOBO-577"
	fixtureId:        #QuickstartFixtureId
	proofMode:        #QuickstartProofMode
	consumingSurface: #Surface
	topologyUse:      #NonEmptyString
}

#TopologySurface: {
	id:                #Surface
	title:             #NonEmptyString
	consumesFrom:      [...#SourceIssue]
	operatingQuestion: #NonEmptyString
}

#SupportHandoff: {
	issue:               #Issue
	sourceIssue:         #SourceIssue
	correlationId:       #NonEmptyString
	customerSafeWording: =~"No customer payloads or provider credentials"
	visibleFields:       [...string]
	withheldFields:      [...string]
	ownerRoute:          #NonEmptyString
	nextAction:          #NonEmptyString
	liveTicketCreated:   false
}

#Snapshot: {
	state:                 #State
	surface:               #Surface
	sourceIssue:           #SourceIssue
	sourceFixtureId:       #NonEmptyString
	projectionSource:      =~".*View$"
	freshnessLabel:        #NonEmptyString
	tenantRbacDisposition: =~".*(tenant|RBAC|redact|denied|scope).*"
	safeNextAction:        =~".*(inspect|wait|route|rollback|review|handoff|escalate).*"
	proofMode:             #ProofMode
	supportHandoff?:       #SupportHandoff
}

#Scenario: {
	id:              "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
	title:           #NonEmptyString
	snapshotStates:  [...#State]
	proofModeLabels: [...#ProofMode]
	safeOutcome:     #NonEmptyString
}

#Prototype: {
	issue:              #Issue
	phase:              "M2"
	targetPackage:      "src/draft/exp-proofs/ux/vibe-topology-status-prototype"
	proofNote:          "docs/design/proofs/vibe-topology-status-prototype/README.md"
	designRefs:         #NonEmptyStringList
	sourceDependencies: [...#SourceDependency]
	quickstartFixtureRefs: [...#QuickstartFixtureRef]
	surfaces:           [...#TopologySurface]
	snapshots:          [...#Snapshot]
	scenarios:          [...#Scenario]
	accessibilityNotes: #NonEmptyStringList
	scopeOut:           #NonEmptyStringList
}

package role_journey_cli_mcp_transcripts

import "list"

#NonEmptyString: string & =~"\\S"
#NonEmptyStringList: [#NonEmptyString, ...#NonEmptyString]
#FixtureId: =~"^rlq-[a-z0-9-]+-v[0-9]+$"
#RoleJourneyRole: "app-developer" | "platform-engineer" | "gitops" | "secops" | "devops" | "sre"
#RoleJourneyCoverage: "deploy" | "manage" | "migrate" | "rollback" | "policy-or-contract-denial" | "support-handoff"
#RoleJourneyNegativePath: "blocked" | "stale-or-unknown-evidence"
#RoleJourneyProofMode: "reference-fixture" | "simulated" | "scope-out"
#StepStatus: "ready" | "blocked" | "stale" | "support" | "rollback" | "migrate" | "deploy"

#RoleJourneyCliMcpTranscripts: {
	issue:                 "HOBO-557"
	phase:                 "M2"
	targetPackage:         "src/draft/exp-proofs/ax/role-journey-cli-mcp-transcripts"
	proofNote:             "docs/design/proofs/role-journey-cli-mcp-transcripts/README.md"
	sourceQuickstartIssue: "HOBO-577"
	sourceQuickstartProof: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md"
	designRefs:            #NonEmptyStringList
	scopeOut:              #NonEmptyStringList
	journeys:              [...#RoleJourney] & list.MinItems(6)
}

#RoleJourney: {
	role:                       #RoleJourneyRole
	title:                      #NonEmptyString
	audience:                   #NonEmptyString
	intent:                     #NonEmptyString
	primaryQuickstartFixtureId: #FixtureId
	coverage:                   [...#RoleJourneyCoverage] & list.MinItems(1)
	negativePaths:              [...#RoleJourneyNegativePath] & list.MinItems(2)
	sequence:                   [...#RoleJourneyStep] & list.MinItems(3)
}

#RoleJourneyStep: {
	id:                     #NonEmptyString
	command:                =~"^hobo "
	expectedTerminalOutput: #NonEmptyString
	quickstartFixtureId:   #FixtureId
	proofMode:              #RoleJourneyProofMode
	jsonResult: #RoleJourneyJsonResult & {
		fixtureId: quickstartFixtureId
		proofMode: proofMode
	}
	mcpResult: #RoleJourneyMcpResult & {
		fixtureId: quickstartFixtureId
		proofMode: proofMode
	}
	supportHandoff:   =~"(?i)support"
	accessibilityNote: =~"(?i)(plain text|screen reader|non-color|stable heading)"
}

#RoleJourneyJsonResult: {
	schema:         "hobo.role-journey-cli-mcp-result/v1"
	status:         #StepStatus
	fixtureId:      #FixtureId
	proofMode:      #RoleJourneyProofMode
	summary:        #NonEmptyString
	supportHandoff: =~"(?i)support"
}

#RoleJourneyMcpResult: {
	tool:         =~"^hobo_"
	status:       #StepStatus
	fixtureId:    #FixtureId
	proofMode:    #RoleJourneyProofMode
	resultSchema: "hobo.role-journey-cli-mcp-result/v1"
}

#RoleJourneyScopeDecision: {
	allowed: bool
	reason:  #NonEmptyString
}

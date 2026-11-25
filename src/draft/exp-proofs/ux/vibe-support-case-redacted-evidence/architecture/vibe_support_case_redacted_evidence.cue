// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#VibeSupportCaseProofMode: "live" | "simulated" | "reference fixture" | "scope-out"

#NonEmptyStringList: [string, ...string]

#ConsumedSupportWorkflowMockupId: "wf-received-intake" | "wf-classified-triage" | "wf-evidence-linked" | "wf-owner-routed" | "wf-customer-updated" | "wf-closed"

#ConsumedSupportWorkflowMockupRef: {
	sourceIssue:     "HOBO-550"
	mockupId:        #ConsumedSupportWorkflowMockupId
	sourceProofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md"
	supportCaseUse:  string & !=""
}

#SupportCaseEvidencePack: {
	id:                  string & !=""
	supportCaseState:    "intake" | "triage" | "evidence-pack" | "owner-route" | "customer-update" | "closure"
	customerSafeSummary: string & !=""
	severity:            "SEV0" | "SEV1" | "SEV2" | "SEV3"
	ownerRoute:          string & !=""
	consumedMockupIds:   #NonEmptyStringList
	redactedLogs:        #NonEmptyStringList
	incidentRefs:        #NonEmptyStringList
	supportRefs:         #NonEmptyStringList
	adminContext:        string & !=""
	docsSource:          string & !=""
	proofPackageLink:    string & !=""
	redactionState:      "customer-safe" | "internal-only" | "requires-security-approval" | "scope-out"
	nextUpdateCondition: string & !=""
	proofMode:           #VibeSupportCaseProofMode
}

#SupportCaseScenarioPath: {
	id:              "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
	narrative:       string & !=""
	evidencePackIds: #NonEmptyStringList
	safeOutcome:     string & !=""
}

#VibeSupportCaseRedactedEvidenceRecord: {
	issue:                               "HOBO-564"
	phase:                               "M2"
	packagePath:                         "src/draft/exp-proofs/ux/vibe-support-case-redacted-evidence"
	proofPath:                           "docs/design/proofs/vibe-support-case-redacted-evidence/README.md"
	designRefs:                          #NonEmptyStringList
	consumedSupportWorkflowMockupRefs:    [#ConsumedSupportWorkflowMockupRef, ...#ConsumedSupportWorkflowMockupRef]
	evidencePacks:                        [#SupportCaseEvidencePack, ...#SupportCaseEvidencePack]
	scenarioPaths:                        [#SupportCaseScenarioPath, ...#SupportCaseScenarioPath]
	accessibilityNotes:                   #NonEmptyStringList
	scopeOut:                             #NonEmptyStringList
}

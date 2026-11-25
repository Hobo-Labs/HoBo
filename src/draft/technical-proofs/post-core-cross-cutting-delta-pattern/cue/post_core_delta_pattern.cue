// CUE constraints for every protobuf type in proto/post_core_delta_pattern.proto.
// These constraints pin docs-pattern evidence only.
package post_core_delta_pattern

#DeltaGateDecision: "accepted" | "rejected"

#PostCoreDeltaRecord: {
	issueId:             =~"^HOBO-[0-9]+$"
	capability:          string & =~"^[A-Za-z0-9 -]+$"
	linearProject:       string & =~"^[A-Za-z0-9 -]+$"
	m0AcceptanceRecord:  string & =~"^docs/design/.+\\.md$"
	designIndexRow:      "docs/design/index.md"
	proofReadme:         string & =~"^docs/design/proofs/.+/README\\.md$"
	traceabilityRow:     "docs/design/traceability.md"
}

#DeltaArtifactEvidence: {
	sourceIssue:             =~"^HOBO-[0-9]+$"
	proofPath:               string & =~"^src/draft/.+"
	proofMode:               "contract-test" | "docs-pattern-proof" | "policy-fixture"
	blockedFollowUpIssues: [...=~"^HOBO-[0-9]+$"]
}

#DeltaTraceabilityRecord: {
	sourceIssue:         =~"^HOBO-[0-9]+$"
	sourceRecord:        string & =~"^docs/design/.+\\.md$"
	proofPackage:        string & =~"^src/draft/.+"
	acceptanceAssertion: string & =~".+"
}

#DeltaGateDecisionRecord: {
	issueId:  =~"^HOBO-[0-9]+$"
	decision: #DeltaGateDecision
	reason:   "accepted-m0-record" | "missing-linear-owner" | "missing-proof-path" | "mutable-completed-epic"
}

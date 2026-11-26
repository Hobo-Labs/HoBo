package architecture_evidence

#DurableAgentPrimitiveContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DurableAgentPrimitiveContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

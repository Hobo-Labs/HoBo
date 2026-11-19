
package architecture_evidence

#TokenReplayResistanceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TokenReplayResistanceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

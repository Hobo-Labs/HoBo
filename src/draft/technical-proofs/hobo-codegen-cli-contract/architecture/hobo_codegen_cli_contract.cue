
package architecture_evidence

#HoboCodegenCliContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboCodegenCliContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

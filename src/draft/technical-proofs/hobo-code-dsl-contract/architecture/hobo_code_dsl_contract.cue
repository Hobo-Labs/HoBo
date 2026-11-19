
package architecture_evidence

#HoboCodeDslContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboCodeDslContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

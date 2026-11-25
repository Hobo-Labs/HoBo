
package architecture_evidence

#HoboComponentizeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboComponentizeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

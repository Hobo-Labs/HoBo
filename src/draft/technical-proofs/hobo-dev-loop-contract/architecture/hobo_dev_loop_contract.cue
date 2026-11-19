
package architecture_evidence

#HoboDevLoopContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboDevLoopContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#ChoreographedCompensationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ChoreographedCompensationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

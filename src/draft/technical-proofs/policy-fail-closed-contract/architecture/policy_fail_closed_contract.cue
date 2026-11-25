
package architecture_evidence

#PolicyFailClosedContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicyFailClosedContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

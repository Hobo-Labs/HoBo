
package architecture_evidence

#HoboBuildCliContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboBuildCliContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

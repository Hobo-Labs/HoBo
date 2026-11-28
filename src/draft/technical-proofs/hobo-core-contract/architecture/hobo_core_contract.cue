
package architecture_evidence

#HoboCoreContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboCoreContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#ForgeCertificationLoopContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ForgeCertificationLoopContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

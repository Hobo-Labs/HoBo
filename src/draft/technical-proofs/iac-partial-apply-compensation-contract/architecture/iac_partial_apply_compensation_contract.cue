
package architecture_evidence

#IacPartialApplyCompensationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IacPartialApplyCompensationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

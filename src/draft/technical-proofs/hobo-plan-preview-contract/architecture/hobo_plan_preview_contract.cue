
package architecture_evidence

#HoboPlanPreviewContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboPlanPreviewContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

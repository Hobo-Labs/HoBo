
package architecture_evidence

#DeltaSetApplyReconcileContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DeltaSetApplyReconcileContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

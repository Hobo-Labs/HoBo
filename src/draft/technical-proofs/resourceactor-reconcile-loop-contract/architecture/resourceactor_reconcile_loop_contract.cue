
package architecture_evidence

#ResourceactorReconcileLoopContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ResourceactorReconcileLoopContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

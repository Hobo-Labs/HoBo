
package architecture_evidence

#RollbackFailureCompensationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RollbackFailureCompensationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

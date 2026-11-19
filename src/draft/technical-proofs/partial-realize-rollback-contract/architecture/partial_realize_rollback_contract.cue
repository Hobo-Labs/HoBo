
package architecture_evidence

#PartialRealizeRollbackContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PartialRealizeRollbackContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

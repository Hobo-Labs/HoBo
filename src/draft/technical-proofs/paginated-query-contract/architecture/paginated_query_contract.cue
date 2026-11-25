
package architecture_evidence

#PaginatedQueryContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PaginatedQueryContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

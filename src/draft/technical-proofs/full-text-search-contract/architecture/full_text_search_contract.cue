
package architecture_evidence

#FullTextSearchContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#FullTextSearchContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

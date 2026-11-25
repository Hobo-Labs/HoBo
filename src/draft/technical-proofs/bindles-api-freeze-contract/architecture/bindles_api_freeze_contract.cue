
package architecture_evidence

#BindlesApiFreezeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BindlesApiFreezeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

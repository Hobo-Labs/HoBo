
package architecture_evidence

#BindReferenceWiringContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BindReferenceWiringContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

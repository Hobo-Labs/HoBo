
package architecture_evidence

#AdoptInPlaceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AdoptInPlaceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

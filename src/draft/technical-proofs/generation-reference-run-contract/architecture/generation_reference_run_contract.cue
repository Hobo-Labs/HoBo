
package architecture_evidence

#GenerationReferenceRunContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationReferenceRunContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#ResourceDefinitionDriverContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ResourceDefinitionDriverContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

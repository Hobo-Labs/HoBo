
package architecture_evidence

#DomainValidationGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DomainValidationGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

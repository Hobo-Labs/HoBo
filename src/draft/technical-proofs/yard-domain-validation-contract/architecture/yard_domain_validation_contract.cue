
package architecture_evidence

#YardDomainValidationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#YardDomainValidationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

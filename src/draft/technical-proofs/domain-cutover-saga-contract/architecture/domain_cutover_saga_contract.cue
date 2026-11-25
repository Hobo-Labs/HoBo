
package architecture_evidence

#DomainCutoverSagaContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DomainCutoverSagaContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

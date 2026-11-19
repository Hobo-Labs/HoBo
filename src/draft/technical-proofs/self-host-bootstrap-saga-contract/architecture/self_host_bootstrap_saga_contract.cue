
package architecture_evidence

#SelfHostBootstrapSagaContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SelfHostBootstrapSagaContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

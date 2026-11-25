
package architecture_evidence

#UsageMeteringScopeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#UsageMeteringScopeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

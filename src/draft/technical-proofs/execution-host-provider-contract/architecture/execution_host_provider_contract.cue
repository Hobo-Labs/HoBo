
package architecture_evidence

#ExecutionHostProviderContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ExecutionHostProviderContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

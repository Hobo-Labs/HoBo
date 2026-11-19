
package architecture_evidence

#RegistryCompromiseGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RegistryCompromiseGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#PortabilitySwapEquivalentContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PortabilitySwapEquivalentContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

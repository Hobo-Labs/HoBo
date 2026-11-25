
package architecture_evidence

#CanDeployCompatibilityGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CanDeployCompatibilityGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

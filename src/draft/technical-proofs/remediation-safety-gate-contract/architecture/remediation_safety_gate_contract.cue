
package architecture_evidence

#RemediationSafetyGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RemediationSafetyGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

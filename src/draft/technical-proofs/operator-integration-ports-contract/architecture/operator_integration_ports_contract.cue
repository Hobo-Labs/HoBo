
package architecture_evidence

#OperatorIntegrationPortsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OperatorIntegrationPortsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

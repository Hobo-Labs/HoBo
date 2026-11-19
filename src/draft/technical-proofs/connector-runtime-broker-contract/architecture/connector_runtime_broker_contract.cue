
package architecture_evidence

#ConnectorRuntimeBrokerContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ConnectorRuntimeBrokerContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

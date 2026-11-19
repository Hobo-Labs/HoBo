
package architecture_evidence

#ConnectorAuthoringContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ConnectorAuthoringContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

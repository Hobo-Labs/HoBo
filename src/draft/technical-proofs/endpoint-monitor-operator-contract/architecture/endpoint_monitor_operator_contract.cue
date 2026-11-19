
package architecture_evidence

#EndpointMonitorOperatorContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#EndpointMonitorOperatorContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

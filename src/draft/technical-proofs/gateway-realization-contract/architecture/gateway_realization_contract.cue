
package architecture_evidence

#GatewayRealizationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GatewayRealizationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

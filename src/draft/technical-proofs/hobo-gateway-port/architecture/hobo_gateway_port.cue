
package architecture_evidence

#HoboGatewayPortEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboGatewayPortRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

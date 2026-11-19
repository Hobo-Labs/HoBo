
package architecture_evidence

#HoboMcpServerContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboMcpServerContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

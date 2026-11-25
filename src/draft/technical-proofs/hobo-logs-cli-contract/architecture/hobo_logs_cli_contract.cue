
package architecture_evidence

#HoboLogsCliContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboLogsCliContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

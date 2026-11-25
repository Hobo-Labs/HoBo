
package architecture_evidence

#HoboCliShellContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboCliShellContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

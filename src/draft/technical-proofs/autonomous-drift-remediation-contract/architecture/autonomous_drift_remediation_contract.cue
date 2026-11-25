
package architecture_evidence

#AutonomousDriftRemediationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AutonomousDriftRemediationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

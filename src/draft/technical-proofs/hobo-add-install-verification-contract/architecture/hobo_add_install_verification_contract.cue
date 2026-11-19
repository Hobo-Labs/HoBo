
package architecture_evidence

#HoboAddInstallVerificationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboAddInstallVerificationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

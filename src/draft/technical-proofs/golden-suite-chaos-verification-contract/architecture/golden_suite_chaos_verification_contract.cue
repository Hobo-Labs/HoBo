
package architecture_evidence

#GoldenSuiteChaosVerificationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GoldenSuiteChaosVerificationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

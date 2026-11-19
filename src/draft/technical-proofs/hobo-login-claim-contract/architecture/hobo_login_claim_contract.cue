
package architecture_evidence

#HoboLoginClaimContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboLoginClaimContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

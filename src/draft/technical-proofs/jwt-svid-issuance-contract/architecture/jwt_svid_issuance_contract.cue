
package architecture_evidence

#JwtSvidIssuanceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#JwtSvidIssuanceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

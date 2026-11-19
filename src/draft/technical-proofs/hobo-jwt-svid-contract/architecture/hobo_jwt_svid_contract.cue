
package architecture_evidence

#HoboJwtSvidContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboJwtSvidContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

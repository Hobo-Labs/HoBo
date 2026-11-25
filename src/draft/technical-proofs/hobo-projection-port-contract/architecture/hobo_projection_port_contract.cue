
package architecture_evidence

#HoboProjectionPortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboProjectionPortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#HoboRemediationActionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboRemediationActionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

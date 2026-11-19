
package architecture_evidence

#HoboCollectCliContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboCollectCliContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

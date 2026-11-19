
package architecture_evidence

#HoboRealizeEmissionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboRealizeEmissionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

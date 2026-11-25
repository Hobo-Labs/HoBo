
package architecture_evidence

#HoboRelayContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboRelayContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

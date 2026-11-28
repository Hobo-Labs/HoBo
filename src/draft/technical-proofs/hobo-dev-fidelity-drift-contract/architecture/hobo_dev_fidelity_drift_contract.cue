
package architecture_evidence

#HoboDevFidelityDriftContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboDevFidelityDriftContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

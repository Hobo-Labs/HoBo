
package architecture_evidence

#AppDevJourneyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AppDevJourneyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

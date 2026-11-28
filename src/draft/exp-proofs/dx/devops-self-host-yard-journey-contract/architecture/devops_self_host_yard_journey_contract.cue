
package architecture_evidence

#DevopsSelfHostYardJourneyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DevopsSelfHostYardJourneyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

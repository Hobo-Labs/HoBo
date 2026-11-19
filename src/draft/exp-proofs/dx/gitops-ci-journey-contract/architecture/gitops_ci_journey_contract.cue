
package architecture_evidence

#GitopsCiJourneyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GitopsCiJourneyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

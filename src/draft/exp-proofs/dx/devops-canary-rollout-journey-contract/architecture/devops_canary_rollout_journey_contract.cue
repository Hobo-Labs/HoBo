
package architecture_evidence

#DevopsCanaryRolloutJourneyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DevopsCanaryRolloutJourneyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

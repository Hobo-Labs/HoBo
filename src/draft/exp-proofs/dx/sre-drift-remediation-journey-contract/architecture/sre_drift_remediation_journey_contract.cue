
package architecture_evidence

#SreDriftRemediationJourneyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SreDriftRemediationJourneyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

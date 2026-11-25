
package architecture_evidence

#SagaCreditReconciliationSpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SagaCreditReconciliationSpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

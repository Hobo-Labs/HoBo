
package architecture_evidence

#IdJagThreatModelSpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IdJagThreatModelSpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

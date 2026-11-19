
package architecture_evidence

#SvidPartitionGraceSpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SvidPartitionGraceSpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

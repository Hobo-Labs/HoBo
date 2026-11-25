
package architecture_evidence

#JunctionConnectivityInferenceSpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#JunctionConnectivityInferenceSpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#NonTsIdiomRoundtripSpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#NonTsIdiomRoundtripSpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

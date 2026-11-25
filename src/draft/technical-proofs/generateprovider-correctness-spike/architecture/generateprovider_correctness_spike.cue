
package architecture_evidence

#GenerateproviderCorrectnessSpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerateproviderCorrectnessSpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

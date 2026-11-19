
package architecture_evidence

#ComponentHostAdapterCertificationSpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ComponentHostAdapterCertificationSpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

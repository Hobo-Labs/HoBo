
package architecture_evidence

#DataFlywheelPrivacySpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DataFlywheelPrivacySpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

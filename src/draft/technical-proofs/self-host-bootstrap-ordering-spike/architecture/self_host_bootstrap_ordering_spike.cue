
package architecture_evidence

#SelfHostBootstrapOrderingSpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SelfHostBootstrapOrderingSpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

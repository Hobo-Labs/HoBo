
package architecture_evidence

#CliMcpDeveloperExperienceEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CliMcpDeveloperExperienceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

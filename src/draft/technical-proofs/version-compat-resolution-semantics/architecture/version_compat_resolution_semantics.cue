
package architecture_evidence

#VersionCompatResolutionSemanticsEvidenceKind: "unspecified" | "design-record" | "contract-test"

#VersionCompatResolutionSemanticsRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

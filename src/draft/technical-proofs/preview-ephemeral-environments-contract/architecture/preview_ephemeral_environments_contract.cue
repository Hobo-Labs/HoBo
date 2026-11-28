
package architecture_evidence

#PreviewEphemeralEnvironmentsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PreviewEphemeralEnvironmentsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

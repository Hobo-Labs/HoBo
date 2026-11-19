
package architecture_evidence

#RepoViewEscapeHatchesContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RepoViewEscapeHatchesContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#MirrorDigestSelectionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MirrorDigestSelectionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

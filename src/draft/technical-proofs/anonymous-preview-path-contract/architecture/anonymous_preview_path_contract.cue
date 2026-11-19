
package architecture_evidence

#AnonymousPreviewPathContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AnonymousPreviewPathContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

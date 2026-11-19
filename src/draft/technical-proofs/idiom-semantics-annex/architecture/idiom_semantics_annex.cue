
package architecture_evidence

#IdiomSemanticsAnnexEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IdiomSemanticsAnnexRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#MatchingSpecificityVectorsEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MatchingSpecificityVectorsRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

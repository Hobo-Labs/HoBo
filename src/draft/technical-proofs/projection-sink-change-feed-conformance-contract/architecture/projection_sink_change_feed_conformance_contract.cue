
package architecture_evidence

#ProjectionSinkChangeFeedConformanceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProjectionSinkChangeFeedConformanceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

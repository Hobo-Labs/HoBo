
package architecture_evidence

#FailureTaxonomySafeFixClassifierEvidenceKind: "unspecified" | "design-record" | "contract-test"

#FailureTaxonomySafeFixClassifierRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

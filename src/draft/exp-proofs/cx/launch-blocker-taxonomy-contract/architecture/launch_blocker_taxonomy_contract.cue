
package architecture_evidence

#LaunchBlockerTaxonomyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LaunchBlockerTaxonomyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

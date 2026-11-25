
package architecture_evidence

#ProductNotificationTaxonomyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProductNotificationTaxonomyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

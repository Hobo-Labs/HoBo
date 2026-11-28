
package architecture_evidence

#LegalPrivacyTermsReadinessContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LegalPrivacyTermsReadinessContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

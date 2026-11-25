
package architecture_evidence

#MarketplacePublisherTrustEvidenceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MarketplacePublisherTrustEvidenceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

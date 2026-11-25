
package architecture_evidence

#MarketplaceUxScopeContractEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "accessibility-review" | "support-handoff" | "launch-claim-review"

#MarketplaceUxScopeContractRecord: {
	issue:                   string & !=""
	summary:                 string & !=""
	listing_states:          [...string]
	installability_outcomes: [...string]
	evidence:                [...string]
}

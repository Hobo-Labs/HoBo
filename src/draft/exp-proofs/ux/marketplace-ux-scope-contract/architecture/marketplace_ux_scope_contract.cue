// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#MarketplaceUxScopeContractEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "accessibility-review" | "support-handoff" | "launch-claim-review"

#MarketplaceUxScopeContractRecord: {
	issue:                   string & !=""
	summary:                 string & !=""
	listing_states:          [...string]
	installability_outcomes: [...string]
	evidence:                [...string]
}

// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#MarketplacePayoutHooksScopeContractEvidenceKind: "unspecified" | "design-record" | "contract-test" | "compliance-review" | "support-handoff"

#MarketplacePayoutHooksScopeContractRecord: {
	issue:              string & !=""
	summary:            string & !=""
	payout_hook_states: [...string]
	evidence:           [...string]
}

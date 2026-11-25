
package architecture_evidence

#MarketplacePayoutHooksScopeContractEvidenceKind: "unspecified" | "design-record" | "contract-test" | "compliance-review" | "support-handoff"

#MarketplacePayoutHooksScopeContractRecord: {
	issue:              string & !=""
	summary:            string & !=""
	payout_hook_states: [...string]
	evidence:           [...string]
}

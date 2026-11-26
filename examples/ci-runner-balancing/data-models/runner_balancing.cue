package data_models

// Constraints for runner_balancing.proto. Parse boundaries in src/parse.ts
// mirror these invariants so invalid registry/usage documents are
// unrepresentable past the boundary (parse, don't validate).

#ProviderKind: int & >=0 & <=4

#CostTrust: int & >=0 & <=3

#DecisionKind: int & >=0 & <=5

#ProviderCostFacts: {
	free_units_per_month:    number & >=0
	free_tier_reset_day:     int & >=0 & <=28
	list_price_usd_per_unit: number & >=0
	unit:                    "minute" | "gib"
	included_multiplier:     number & >=0
	trust:                   #CostTrust
}

#RunnerProviderProfile: {
	id:            string & =~"^[a-z][a-z0-9_]*$"
	display_name:  string & !=""
	kind:          #ProviderKind
	runs_on_labels: [...string & !=""] & [_, ...]
	cost:          #ProviderCostFacts
	docs_url:      string
}

#UsageSnapshot: {
	provider_id: string & !=""
	spend_usd:   number & >=0
	units_used:  number & >=0
	known:       bool
	source:      string
}

#BudgetEnvelope: {
	provider_id:  string & !=""
	soft_cap_usd: number & >=0
	hard_cap_usd: number & >=0
	// The hard cap can never sit below the soft cap it backs.
	_soft_within_hard: true & (hard_cap_usd >= soft_cap_usd)
}

#RungGuard: {
	variable: string & !=""
	values: [...string]
	exists: bool
}

#TrackRung: {
	value:       string & !=""
	provider_id: string & !=""
	requires: [...#RungGuard]
	sticky_reason: string
	last_resort:   bool
}

#RunnerTrack: {
	resource: string & =~"^[a-z][a-z0-9._-]*$"
	variable: string & =~"^[A-Z][A-Z0-9_]*$"
	rungs: [...#TrackRung] & [_, ...]
}

#HardBlockSignal: {
	provider_id: string & !=""
	resource:    string
	reason:      string
}

#CreditEntry: {
	provider_id:                 string & !=""
	effective_marginal_cost_usd: number & >=0
	free_headroom_units:         number & >=0
	spend_usd:                   number & >=0
	envelope_usd:                number & >=0
	usage_known:                 bool
	hard_blocked:                bool
	list_price_usd_per_unit:     number & >=0
}

#CreditLedgerView: {
	seq: string & !=""
	entries: [...#CreditEntry]
}

#RebalanceRequested: {
	requested_by: string & !=""
	mode:         "plan" | "apply"
	ledger_seq:   string
}

#DispatchDecision: {
	resource:     string & !=""
	variable:     string & !=""
	from_value:   string
	to_value:     string
	provider_id:  string
	kind:         #DecisionKind
	reason:       string
	usage_known:  bool
	ledger_seq:   string & !=""
	spend_usd:    number & >=0
	envelope_usd: number & >=0
	direction:    "" | "up" | "back"
}

#RebalancePlan: {
	ledger_seq: string & !=""
	decisions: [...#DispatchDecision]
}

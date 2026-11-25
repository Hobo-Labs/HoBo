package architecture_evidence

#VibePlanReviewProofMode: "live" | "simulated" | "reference fixture" | "scope-out"

#VibePlanReviewState: {
	id:                    "create" | "update" | "no-op" | "destructive" | "blocked" | "stale" | "unknown-evidence"
	evidence_source:       string & !=""
	owner:                 string & !=""
	safe_next_action:      string & !=""
	risk_category:         string & !=""
	policy_disposition:    string & !=""
	cost_disposition:      string & !=""
	capacity_disposition:  string & !=""
	customer_safe_wording: string & !=""
	proof_mode:            #VibePlanReviewProofMode
}

#VibePlanReviewStatesRecord: {
	issue:        "HOBO-542"
	package_path: "src/draft/exp-proofs/ux/vibe-plan-review-states"
	proof_path:   "https://linear.app/quickdeploy-ai/document/hobo-542-vibe-plan-review-states-proof-archived-22175c3b581c"
	states: [...#VibePlanReviewState]
	quickstart_fixture_ids: [...string & =~"^rlq-[a-z0-9-]+-v[0-9]+$"]
}

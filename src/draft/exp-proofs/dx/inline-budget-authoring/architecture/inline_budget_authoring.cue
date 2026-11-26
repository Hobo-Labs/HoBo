package architecture_evidence

#InlineBudgetPolicyRecord: {
	camp:                 string & !=""
	projected_monthly_usd:  number & >=0
	soft_limit_usd:       number & >=0
	hard_limit_usd:       number & >=0
	active_tier:          string
}

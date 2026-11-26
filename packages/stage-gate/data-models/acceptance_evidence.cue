package stage_gate

// AcceptanceEvidence: the release gate's reading of one ai-bdd run report
// (ADR-0172). parseAiBddRunReport in src/acceptance.ts enforces the same
// constraints and also checks totals against the scenarios themselves. Every
// field is required (`!`), here and wherever a block below constrains it: CUE
// would otherwise fill an absent `model_calls` with 0 and an absent
// `scenarios_total` with the sum below, and a regular field unified with a
// required one satisfies the requirement.
#AcceptanceEvidence: {
	// One directory name under .ai-bdd/runs/.
	run_id!:          string & =~"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
	report_digest!:   #DigestSha256
	// Date.prototype.toISOString(), the form RunReport v1 pins.
	started_at!: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
	scenarios_total!: int & >=0
	passed!:          int & >=0
	healed!:          int & >=0
	failed!:          int & >=0
	inconclusive!:    int & >=0
	blocked!:         int & >=0
	error!:           int & >=0
	skipped!:         int & >=0
	fuzzy_steps!:     int & >=0

	// Replay-only: committed plans, recordings and nothing else.
	model_calls!: 0
	frozen!:      true
	no_agent!:    true

	exit_code!: 0 | 1 | 2 | 3 | 4

	scenarios_total!: passed + healed + failed + inconclusive + blocked + error + skipped

	_notPassed: failed + inconclusive + blocked + error
	_replayed:  passed + healed
	if exit_code == 0 {
		_notPassed: 0
		// An empty or all-skipped run exits 0 too; it replayed nothing.
		scenarios_total!: >0
		_replayed:        >0
	}
}

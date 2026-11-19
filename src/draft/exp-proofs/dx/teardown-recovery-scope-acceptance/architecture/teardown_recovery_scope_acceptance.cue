
package architecture_evidence

#TeardownRecoveryState: "unspecified" | "requested" | "blocked" | "draining" | "teardown-ready" | "recoverable" | "terminal" | "escalated"

#TeardownRecoveryMode: "unspecified" | "resume" | "rollback" | "restore-from-evidence" | "manual-escalation"

#TeardownRecoveryScopeRecord: {
	issue:             string & !=""
	summary:           string & !=""
	teardown_states:   [...string]
	recovery_modes:    [...string]
	required_evidence: [...string]
	m1_evidence:       [...string]
}

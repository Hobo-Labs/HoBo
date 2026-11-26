// CUE constraints for S6-02 control-plane HA contract evidence.

package architecture_evidence

#ControlPlaneHaEvidenceKind: "unspecified" | "quorum-append" | "leader-failover" | "provider-resilience"

#ControlPlaneHaContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

#QuorumFencedAppend: {
	stream_id:   string & !=""
	seq:         int & >=1
	fence_token: int & >=1
	event_type:  string & !=""
}

#LeaderFailoverOutcome: {
	leader_node:              string & !=""
	successor_node:           string & !=""
	recovery_ms:              int & >=0 & <=30000
	duplicate_actions_blocked: bool
}

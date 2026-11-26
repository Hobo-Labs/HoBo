// CUE constraints for cloud Yard shell gateway, event store, and projection records.

package architecture_evidence

#CloudYardShellEvidenceKind: "unspecified" | "gateway-command" | "deployment-event" | "timeline-projection"

#DeployRequestedCommand: {
	deployment_id: string & !=""
	bindle_ref:    string & !=""
	camp:          string & !=""
	yard:          string & !=""
	principal:     string & !=""
}

#DeploymentTimelineEntry: {
	deployment_id: string & !=""
	phase:         string & !=""
	occurred_at:   string & !=""
	seq:           int & >=1
}

#CloudYardShellRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

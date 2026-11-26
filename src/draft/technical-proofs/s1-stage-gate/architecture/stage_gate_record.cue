package stage_gate

#GateId: "s1-stage-gate"

#CheckStatus: "pass" | "fail"

#CheckId:
	"runtime-port-conformance" |
	"offline-hello-bindle" |
	"replay-equals-live"

#StageGateCheck: {
	check_id:    #CheckId
	status:      #CheckStatus
	duration_ms: uint & >=0
	report_ref:  string
}

#StageGateS1Record: {
	gate_id:           #GateId
	commit_sha:        string & !=""
	workflow_run_url:  string
	recorded_at:       string & !=""
	checks: [
		#StageGateCheck & {check_id: "runtime-port-conformance"},
		#StageGateCheck & {check_id: "offline-hello-bindle", duration_ms: uint & <=60000},
		#StageGateCheck & {check_id: "replay-equals-live"},
	]
}

#ValidGreenRecord: #StageGateS1Record & {
	checks: [
		{check_id: "runtime-port-conformance", status: "pass", ...},
		{check_id: "offline-hello-bindle", status: "pass", duration_ms: uint & <=60000, ...},
		{check_id: "replay-equals-live", status: "pass", ...},
	]
}

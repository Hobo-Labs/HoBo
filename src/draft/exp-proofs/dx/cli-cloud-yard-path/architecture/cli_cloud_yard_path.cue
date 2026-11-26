package architecture_evidence

#CliCloudProofMode: "reference-fixture" | "simulated"

#CliCloudCommandStatus: "success" | "blocked" | "error"

#CliCloudActionableError: {
	code:            string & !=""
	cause:           string & !=""
	remediation:     [...string] & [_, ...] & [_, ...]
	correlation_id:  string & !=""
}

#CliCloudLoginResult: {
	svid:       string & !=""
	scopes:     [...string] & [_, ...]
	proof_mode: #CliCloudProofMode
}

#CliCloudPlanWarning: {
	code:    string & !=""
	message: string & !=""
}

#CliCloudPlanResult: {
	deployment_plan_id: string & !=""
	warnings:           [...#CliCloudPlanWarning]
	status:             #CliCloudCommandStatus
	error?:             #CliCloudActionableError
}

#CliCloudDeployResult: {
	deployment_id:     string & !=""
	deployment_set_id: string & !=""
	status:            #CliCloudCommandStatus
	error?:            #CliCloudActionableError
}

#CliCloudInspectDeployResult: {
	deployment_id:  string & !=""
	projection_seq: int & >=0
	state:          string & !=""
	status:         #CliCloudCommandStatus
	error?:         #CliCloudActionableError
}

#CliCloudLogLine: {
	stream:    "stdout" | "event" | "stderr"
	message:   string & !=""
	timestamp: string & !=""
}

#CliCloudLogsResult: {
	lines:  [...#CliCloudLogLine]
	status: #CliCloudCommandStatus
	error?: #CliCloudActionableError
}

#CliCloudJourneyStep: {
	command:    "hobo login" | "hobo plan" | "hobo deploy" | "hobo destroy" | "hobo inspect deploy" | "hobo logs"
	status:     #CliCloudCommandStatus
	fixture_id: "dx.lifecycle.hello-bindle.v1"
}

#CliCloudYardPathRecord: {
	issue:          "HOBO-625"
	phase:          "M1"
	fixture_id:     "dx.lifecycle.hello-bindle.v1"
	bindle:         "examples/hello-bindle"
	proof_note:     "docs/design/proofs/cli-cloud-yard-path/README.md"
	j1_journey:     [...#CliCloudJourneyStep]
	gateway_routes: [...string] & [_, ...]
	scope_out:      [...string] & [_, ...]
}

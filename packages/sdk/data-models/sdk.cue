// CUE constraints for every protobuf type in sdk.proto, so the architecture
// guard can confirm each SDK declaration is bounded at parse time.

package sdk

#WaiverDeclaration: {
	schema:      "hobo.sdk/v1.waiver"
	decision_id: string & !=""
	reason:      string & !=""
	approver:    string & =~"^(role|user|spiffe):.+"
	expires:     string & !="" // RFC 3339 timestamp
}

#ChaosInjection: {
	fault:  string & !=""
	target: string & !=""
}

#ChaosDeclaration: {
	schema:       "hobo.sdk/v1.chaos"
	name:         string & !=""
	steady_state: string & !=""
	inject:       #ChaosInjection
	blast_radius: string & !=""
	abort_if?:    string & !=""
}

#RunbookTrigger: {
	alert:     string & !=""
	severity?: string & !=""
}

#RunbookFixStep: {
	when:      string & !=""
	do:        string & !=""
	gate:      "auto" | "require-approval"
	args_json: string
}

#RunbookDeclaration: {
	schema: "hobo.sdk/v1.runbook"
	name:   string & !=""
	on:     #RunbookTrigger
	diagnose: [...string & !=""] & [_, ...]
	fix: [...#RunbookFixStep] & [_, ...]
}

#GenerateProviderRequest: {
	schema:   "hobo.sdk/v1.generate-provider"
	docs_url: string & =~"^https?://"
	pipeline: ["scaffold", "llm-fill", "sandbox-conformance", "sign"]
}

#RunnerDeclaration: {
	schema:      "hobo.sdk/v1.runner"
	kind:        "self-hosted" | "github" | "depot" | "blacksmith"
	provider_id: string & !=""
	category:    "runner"
	behind?:     "relay"
	list_unit_cost: number & >=0
	switching_cost: number & >=0
}

#PluginExtensionEntry: {
	point:       string & =~"^hobo\\.[a-z0-9][a-z0-9.-]*\\/v[0-9]+$"
	export_name: string & !=""
	id?:         string & !=""
}

#PluginDeclaration: {
	schema:       "hobo.sdk/v1.plugin"
	package_name: string & !=""
	entry:        string & =~"^\\./.+"
	extensions: [...#PluginExtensionEntry] & [_, ...]
}

#OperatorExecutionFact: {
	execution_id: string & !=""
	kind: "waiver" | "chaos" | "runbook" | "runner" | "provider-generation"
	step: string & !=""
	status: string & !=""
	detail_json: string
}

#RunbookDiagnosis: {
	conditions: [...string & !=""]
	evidence_json: string
}

#RunbookExecutionResult: {
	execution_id: string & !=""
	status: "completed" | "blocked" | "unmatched"
	completed_actions: [...string & !=""]
	reason: string & !=""
}

#WaiverExecutionState: {
	decision_id: string
	status: "missing" | "requested" | "approved" | "expired" | "revoked"
	requester?: string & !=""
	approved_by?: string & !=""
	declaration?: #WaiverDeclaration
	policy_fingerprint?: string & !=""
	revision: int & >=0
	if status == "approved" {
		approved_by: string & !=""
		declaration: #WaiverDeclaration
	}
}

#LocalRunnerJob: {
	job_id: string & !=""
	argv: [string & !="", ...string]
	cwd: string & !=""
	env?: [string]: string
	timeout_ms?: int & >0
	max_output_bytes?: int & >0
}

#RunnerExecutionResult: {
	job_id: string & !=""
	provider_id: string & !=""
	status: "succeeded" | "failed"
	exit_code: int
	stdout: string
	stderr: string
	timed_out: bool
	if status == "succeeded" {
		exit_code: 0
		timed_out: false
	}
}

#GeneratedProviderReceipt: {
	provider_id: string & !=""
	source_path: string & !=""
	digest: string & =~"^[a-f0-9]{64}$"
	signature: string & !=""
	public_key: string & !=""
	operation_count: int & >0
}

// A complete SDK wire document, used by the package's executed fixture gate.
#Sdk: #WaiverDeclaration | #ChaosDeclaration | #RunbookDeclaration |
	#GenerateProviderRequest | #RunnerDeclaration | #PluginDeclaration |
	#OperatorExecutionFact | #RunbookDiagnosis | #RunbookExecutionResult |
	#WaiverExecutionState | #LocalRunnerJob | #RunnerExecutionResult |
	#GeneratedProviderReceipt

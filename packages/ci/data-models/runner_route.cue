package ci

import "list"

#HostedRunnerProvider: "blacksmith" | "depot" | "namespace" | "warpbuild" | "ubicloud" | "boat" | "runs-on"
#RunnerStepKey:        "fleet" | "machine" | "github" | #HostedRunnerProvider
// A `runs-on` label: one label, never a comma-separated list.
#RunnerLabel: string & =~"^[A-Za-z0-9][A-Za-z0-9_.:=/@+-]{0,199}$"

// A limit belongs to the kind of step that can measure it: included minutes
// are GitHub's, a monthly spend is a hosted provider's.
#RunnerOrderStep: {key: "fleet" | "machine"} | {key: "github", minutesLimitPercent?: int & >=1 & <=100} | {key: #HostedRunnerProvider, spendLimitUsd?: int & >=1 & <=100000}

#RunnerRetryPolicy: {enabled?: bool, runner: "any" | "same" | "other", max: 1 | 2}

// Step uniqueness (each key once; `github` twice only as one limited and one
// unlimited step) is a cross-element rule the parser enforces.
#RunnerOrder: {
	steps: [#RunnerOrderStep, ...#RunnerOrderStep] & list.MaxItems(16)
	skipUnhealthy?: bool
	retry?:         #RunnerRetryPolicy
	autoSizeVcpus?: 2 | 4 | 8 | 16 | 32
}

// `auto` asks for the order's size; it is never mixed with a written label.
#RunnerRelayInput: {key: #RunnerStepKey, labels: [#RunnerLabel, ...#RunnerLabel] & list.MaxItems(16)}

#RunnerRouteRequest: {
	repository: string & =~"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$"
	private?:   bool
	fork?:      bool
	event:      string & =~"^[a-z_]{1,60}$"
	runId:      int & >0
	runAttempt: int & >=1 & <=1000
	job:        string & =~"^[A-Za-z_][A-Za-z0-9_-]{0,99}$"
	inputs?: [...#RunnerRelayInput] & list.MaxItems(16)
	actorId?:           string & =~"^[0-9]{1,20}$"
	triggeringActorId?: string & =~"^[0-9]{1,20}$"
	workflowRef?:       string & !=""
}

#RunnerSkipReason: "not_configured" | "public_repository" | "fork_pull_request" | "needs_isolation" | "no_size" | "too_many_labels" | "not_provider_label" | "minutes_limit" | "minutes_runway" | "spend_limit" | "provider_unhealthy" | "fleet_off" | "fleet_full" | "no_machine" | "machine_paused" | "machine_not_shared" | "machine_full"

#RunnerRouteSkip: {key: #RunnerStepKey, reason: #RunnerSkipReason, detail?: string}

#RunnerRouteDecision: {
	skipped?: [...#RunnerRouteSkip]
	notInOrder?: [...#RunnerStepKey]
	{outcome: "routed", runner: #RunnerLabel, step: #RunnerStepKey, machineId?: string & !="", unhealthyFallback?: bool} |
	{outcome: "waiting", runner: #RunnerLabel, step: "fleet" | "machine", machineId?: string & !=""} |
	{outcome: "none", reason: string & !=""}
}

#RunnerRouteRecord: #RunnerOrder | #RunnerRouteRequest | #RunnerRouteDecision
// Fixtures under fixtures/runner_route are runner-route records; the
// package-wide fixtures are #Ci records and are vetted against this definition
// too.
#RunnerRoute: *#RunnerRouteRecord | #Ci

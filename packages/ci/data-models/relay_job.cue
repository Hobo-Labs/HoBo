package ci

import "list"

#RelayJobValueName: string & =~"^[a-z][a-z0-9_-]{0,63}$"
#RelayJobValue: {name: #RelayJobValueName, value?: string}

#RelayJobStepInput: {name: string & =~"^[A-Za-z_][A-Za-z0-9_-]{0,99}$", value?: string}
#RelayJobStep: {
	uses?: string
	inputs?: [...#RelayJobStepInput] & list.MaxItems(64)
}

#RelayJobMessage: {
	jobId:              string & !=""
	planId:             string & !=""
	repository:         string & =~"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$"
	runId:              int & >0
	runAttempt:         int & >=1 & <=1000
	job:                string & =~"^[A-Za-z_][A-Za-z0-9_-]{0,99}$"
	event:              string & =~"^[a-z_]{1,60}$"
	actorId?:           string & =~"^[0-9]{1,20}$"
	triggeringActorId?: string & =~"^[0-9]{1,20}$"
	private?:           bool
	fork?:              bool
	workflowRef?:       string & !=""
	inputs?: [...#RelayJobValue] & list.MaxItems(32)
	steps?: [...#RelayJobStep] & list.MaxItems(256)
}

#RelayJobAnnotation: {level: "error" | "warning" | "notice", message: string & !=""}

#RelayJobAnswer: {
	jobId:  string & !=""
	planId: string & !=""
	outputs?: [...#RelayJobValue] & list.MaxItems(32)
	{
		conclusion: "succeeded"
		annotations?: [...#RelayJobAnnotation]
	} | {
		conclusion: "failed"
		annotations: [#RelayJobAnnotation, ...#RelayJobAnnotation]
	}
}

#RunnerRouteEvent: {
	accountId: string & !=""
	atMs:      int & >0
	request:   #RunnerRouteRequest
	mode:      "job" | "relay"
	node:      string & !=""
	jobId?:    string & !=""
	{type: "runner.route.Requested"} | {type: "runner.route.Decided", decision: #RunnerRouteDecision}
}

#MachineAdvert: {
	id:        string & !=""
	accountId: string & !=""
	name:    string & !=""
	runsOn:  #RunnerLabel
	labels: [...#RunnerLabel] & list.MaxItems(32)
	os:      "linux" | "macos" | "windows"
	arch:    "x64" | "arm64" | "arm"
	slots:   int & >=1 & <=1000
	busy?:   int & >=0 & <=1000
	paused?: bool
	sharing: "only_me" | "anyone"
	ownerId: string & =~"^[0-9]{1,20}$"
	ownerLogin: string & !=""
	repository?:     string & =~"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$"
	lastSeenMs:      int & >0
	signerKeyId:     string & !=""
	isolation:       "container" | "host"
	lastPickedAtMs?: int & >=0
}

#ProviderOutcomeRecord: {atMs: int & >0, started?: bool}

#ProviderHealthRecord: {
	key: string & =~"^[a-z-]+:.+$"
	outcomes?: [...#ProviderOutcomeRecord] & list.MaxItems(16)
	trippedAtMs?:      int & >0
	backoffMs?:        int & >=0
	nextTrialAtMs?:    int & >0
	trialStartedAtMs?: int & >0
}

#InsightConclusion: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "unknown"

#StepFact: {
	name:           string
	number:         int & >=1
	conclusion:     #InsightConclusion
	startedAtMs?:   int & >=0
	completedAtMs?: int & >=0
}

#JobFact: {
	id:   int & >0
	name: string
	labels?: [...string]
	runnerName?:    string
	runnerGroup?:   string
	conclusion:     #InsightConclusion
	queuedAtMs:     int & >=0
	startedAtMs?:   int & >=0
	completedAtMs?: int & >=0
	steps?: [...#StepFact]
	needs?: [...string]
	billed?: bool
	relay?:  bool
}

#RunFact: {
	id:             int & >0
	attempt:        int & >=1
	repository:     string & =~"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$"
	workflow:       string
	workflowPath:   string
	event:          string & !=""
	branch:         string
	defaultBranch:  string
	headSha:        string & =~"^[0-9a-f]{40}$"
	actor:          string
	conclusion:     #InsightConclusion
	createdAtMs:    int & >=0
	completedAtMs?: int & >=0
	jobs?: [...#JobFact]
	changedPaths?: [...string]
	title?: string
}

#RelayJobRecord: #RelayJobMessage | #RelayJobAnswer | #RunnerRouteEvent | #MachineAdvert | #ProviderHealthRecord | #RunFact
#RelayJob: *#RelayJobRecord | #Ci

package agent

import "list"

// schema-tools vets every fixture against the file-named root definition.
#Agent: #AgentConfig | #QueueSnapshot | #PairVerdict | #QueuePlan | #Resolution | #AgentEvent

#Sha: string & =~"^[a-f0-9]{40}$"
#Digest: string & =~"^[a-f0-9]{64}$"
#Repository: string & =~"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
#Number: int & >=1 & <=2147483647
#Path: string & !="" & !~"^/|\\x00|(^|/)\\.\\.(/|$)"

// A credential is a reference. A value that is not one of these names fails.
#CredentialRef: =~"^(env|github-secret):[A-Z][A-Z0-9_]{0,63}$"

#AgentEngine: {
	id:    string & =~"^[a-z][a-z0-9-]{0,62}$"
	kind:  "gateway" | "openai" | "anthropic" | "google" | "openai-compatible" | "harness"
	model: string & =~"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$"
	credential?: #CredentialRef
	baseUrl?:    string & =~"^https://[^\\s?#]+$"
	if kind == "openai-compatible" {baseUrl: string}
	if kind != "openai-compatible" {baseUrl?: ""}
	if kind == "harness" {
		model:       "claude-code" | "codex" | "pi" | "opencode" | "grok-build"
		credential?: ""
	}
}

#QueuePolicy: {
	maxDepth?:       int & >=1 & <=50
	maxBatchSize?:   int & >=1 & <=20
	maxWaitMinutes?: int & >=1 & <=10080
	priorityLabels?: [...string & =~"^[^\\x00-\\x1f]{1,50}$"] & list.MaxItems(16)
	rollup?:         bool
	label?:          string & =~"^[^\\x00-\\x1f]{1,50}$"
}

#ResolutionPolicy: {
	protectedPaths?:     [...string & =~"^[^\\x00-\\x1f]{1,200}$"] & list.MaxItems(64)
	maxConflictedFiles?: int & >=1 & <=50
	maxConflictRegions?: int & >=1 & <=200
	maxFileBytes?:       int & >=1 & <=1048576
	minConfidence?:      (int | float) & >=0 & <=1
	contextLines?:       int & >=0 & <=200
	maxRepairs?:         int & >=0 & <=3
	structuredMerge?:    bool
}

#AgentBudget: {
	maxInputTokens?:         int & >=1 & <=2000000
	maxOutputTokens?:        int & >=1 & <=200000
	maxTokensPerDay?:        int & >=1 & <=1000000000
	timeoutSeconds?:         int & >=1 & <=900
	maxResolutionsPerTick?:  int & >=1 & <=20
}

#CommitPolicy: {
	name?:       string & =~"^[^<>\\n\\x00]{1,100}$"
	email?:      string & =~"^[^<>\\s\\x00]+@[^<>\\s\\x00]+$"
	signingKey?: #CredentialRef
}

#AgentConfig: {
	mode:        "observe" | "suggest" | "apply"
	commit?:     #CommitPolicy
	engines:     [#AgentEngine, ...#AgentEngine] & list.MaxItems(8)
	queue?:      #QueuePolicy
	resolution?: #ResolutionPolicy
	budget?:     #AgentBudget
	// Rolling several pull requests into one branch is never applied unattended.
	if mode == "apply" {queue?: rollup?: false}
}

#QueueEntry: {
	number:        #Number
	headSha:       #Sha
	headRef:       string & !=""
	baseRef:       string & !=""
	position?:     int & >=0
	enqueuedAt:    string & =~"^\\d{4}-\\d{2}-\\d{2}T"
	labels?:       [...string]
	dependsOn?:    [...#Number]
	changedPaths?: [...#Path]
	fork?:         bool
	started?:      bool
}

#QueueSnapshot: {
	repository: #Repository
	baseRef:    string & !=""
	baseSha:    #Sha
	observedAt: string & =~"^\\d{4}-\\d{2}-\\d{2}T"
	entries?:   [...#QueueEntry] & list.MaxItems(50)
}

// "unknown" is planned as a conflict; only a real conflict names paths.
#PairVerdict: {
	first:   #Number
	second:  #Number
	verdict: "clean" | "conflict" | "unknown"
	paths?:  [...#Path]
	if verdict != "conflict" {paths?: []}
}

#PlanBatch: {numbers: [#Number, ...#Number]}

#PlanResolution: {
	number:   #Number
	against?: [...#Number]
	paths?:   [...#Path]
}

#QueuePlan: {
	repository:   #Repository
	baseSha:      #Sha
	order?:       [...#Number]
	batches?:     [...#PlanBatch]
	resolutions?: [...#PlanResolution]
	moved?:       [...#Number]
	digest:       #Digest
}

// protobuf JSON writes a 64-bit count as a decimal string.
#TokenUsage: {
	inputTokens?:  =~"^[0-9]{1,19}$" | (int & >=0)
	outputTokens?: =~"^[0-9]{1,19}$" | (int & >=0)
}

#RecordedRegion: {
	conflictSha256: #Digest
	resolution:     string
}

#ResolvedFile: {
	path:          #Path
	regions?:      int & >=0
	confidence?:   (int | float) & >=0 & <=1
	contentSha256: #Digest
	structured?:   bool
}

#Resolution: {
	key:           #Digest
	repository:    #Repository
	number?:       #Number
	oursSha:       #Sha
	theirsSha:     #Sha
	outcome:       "resolved" | "abstained" | "failed"
	reason?:       string & =~"^[a-z][a-z0-9-]{0,62}$"
	files?:        [...#ResolvedFile]
	engineId?:     string
	model?:        string
	usage?:        #TokenUsage
	commitSha?:    "" | #Sha
	publishedRef?: string
	regions?:      [...#RecordedRegion]
	repairs?:      "" | #Digest
	attempt?:      int & >=0 & <=3
	// A repair is a later attempt, and a later attempt repairs something.
	if repairs != _|_ if repairs != "" {attempt: int & >=1}
	// Only a resolved merge has a commit, and only a commit can be published.
	if outcome == "resolved" {commitSha: #Sha}
	if outcome != "resolved" {
		reason:        string
		commitSha?:    ""
		publishedRef?: ""
	}
}

#AgentEvent: {
	id:          string & !=""
	type:        "ci.agent.PlanProposed" | "ci.agent.ResolutionSettled" | "ci.agent.ResolutionPublished" | "ci.agent.RollupPublished" | "ci.agent.EntryEnqueued" | "ci.agent.BudgetExhausted" | "ci.agent.ApplyWithheld" | "ci.agent.ResolutionChecked" | "ci.agent.EntryEjected"
	at:          string & =~"^\\d{4}-\\d{2}-\\d{2}T"
	repository:  #Repository
	plan?:       #QueuePlan
	resolution?: #Resolution
	numbers?:    [...#Number]
	headSha?:    #Sha
	checksState?: "" | "success" | "failure"
	if type == "ci.agent.PlanProposed" {plan: #QueuePlan}
	if type == "ci.agent.ResolutionSettled" || type == "ci.agent.ResolutionPublished" || type == "ci.agent.RollupPublished" {resolution: #Resolution}
	if type == "ci.agent.EntryEnqueued" || type == "ci.agent.EntryEjected" {numbers: [#Number], headSha: #Sha}
	if type == "ci.agent.ResolutionChecked" {
		resolution:  #Resolution
		checksState: "success" | "failure"
	}
}

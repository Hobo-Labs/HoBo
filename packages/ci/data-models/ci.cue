package ci

#SandboxAllowance: {
 cpuVcpuMs: int & >=0
 memoryMbMs: int & >=0
 egressBytes: int & >=0
 creations: int & >=0
 proxyBytes: int & >=0
 proxySessions: int & >=0
 proxyControlCalls?: int & >=0
}
#SandboxPricing: {
 vcpus: int & >=1 & <=32
 memoryMb: int & >=1 & <=1048576
 cpuMicrosPerVcpuHour: int & >=1
 memoryMicrosPerGbHour: int & >=1
 creationMicros: int & >=1
 egressMicrosPerGb: int & >=1
 maxEgressBytes: int & >=1
 proxyMicrosPerGb: int & >=1
 proxyFixedMicros: int & >=1
 networkHeadroomBytes: int & >=1
 bootstrapFixedMicros: int & >=1
 proxyVmRequired?: bool
 proxyVmVcpus?: int & >=0 & <=32
 proxyVmMemoryMb?: int & >=0 & <=1048576
 proxyVmExtraMs?: int & >=0
 proxyVmNetworkBytes?: int & >=0
 proxyVmNetworkHeadroomBytes?: int & >=0
 region?: string
 proxyControlMaxCalls?: int & >=0
 proxyControlCallMicros?: int & >=0
 plan?: "" | "hobby" | "pro" | "enterprise"
}
#SandboxMeasuredUsage: {
 sessionId: string & !=""
 cpuMs: int & >=0
 durationMs: int & >=0
 memoryMb: int & >=1
 vcpus: int & >=1
 egressBytes: int & >=0
 ingressBytes: int & >=0
 stoppedAt: string & !=""
}
#Offer: {
 id: string & !=""
 provider: "github" | "blacksmith" | "depot" | "warpbuild" | "kubernetes" | "hobo-box-worker" | "local" | "dagger" | "cloudflare" | "vercel" | "azure-devops"
 providerAccountId: string & !=""
 enabled: bool
 runsOn: string & !=""
 freeMinutes: number & >=0
 priceMicrosPerMinute: int & >=0
 budgetMicros: int & >=0
 spentMicros: int & >=0
 concurrency: int & >=1 & <=1000
 observedAt: string & !=""
 validUntil: string & !=""
 sourceUrl: string & =~"^https://"
 bridgeAcknowledged: bool
 backend?: "" | "gh-actions" | "dagger" | "cf" | "sandbox" | "ado" | "isolated-container"
 if provider == "azure-devops" {backend: "ado"}
 if backend != _|_ {if backend == "ado" {provider: "azure-devops"}}
 if backend == "sandbox" {provider: "vercel"}
 if backend == "isolated-container" {
  provider: "hobo-box-worker" | "kubernetes"
  freeMinutes: 0
  priceMicrosPerMinute: 0
  runsOn: "hobo-isolated-worker"
 }
 sandboxPricing?: #SandboxPricing
 sandboxAllowance?: #SandboxAllowance
 if provider == "local" {
  backend: "gh-actions"
  runsOn: "hobo-local-host"
  concurrency: 1
  freeMinutes: 0
  priceMicrosPerMinute: 0
 }
}
#Account: {
 id: string & !=""
 budgetMicros: int & >=0
 spentMicros: int & >=0
 maxRuntimeMinutes: int & >=1 & <=330
 startupMinutes: int & >=1 & <=20
 offers: [...#Offer]
 usageObservedAt?: string
 routingSignalCycles?: [string]: int & >0 & <=4294967295
 routingSignalCrossed?: [string]: bool
}
#Connection: {
 accountId: string & !=""
 repository: string & =~"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
 repositoryId: int & >0
 installationId: int & >0
 runnerGroupId: int & >=1
 allowedEvents: [...("push" | "workflow_dispatch" | "pull_request")]
 allowedRefs: [...string]
 trustedRepositoryAcknowledged: true
 publicRepositoryAcknowledged?: bool
 allowAllPullRequests?: bool
} & ({
 isolatedOnly: true
 acceptAllMatchingRepositoryJobs: true
 publicRepositoryAcknowledged: true
 allowAllPullRequests?: false
 allowedEvents: []
 allowedRefs: []
 bridgeWorkflow?: ""
 bridgeSha?: ""
 bridgeRef?: ""
 dispatcherActorId?: 0
} | {
 isolatedOnly?: false
 acceptAllMatchingRepositoryJobs?: false
 bridgeWorkflow: string & =~"^[A-Za-z0-9_-]+[.]ya?ml$"
 bridgeSha: string & =~"^[a-f0-9]{40}$"
 bridgeRef: string & =~"^[A-Za-z0-9_/-]+$"
 dispatcherActorId: int & >0
})
#Configuration: {accounts: [...#Account], connections: [...#Connection]}
#ConfigurationState: {revision: int & >=1, configuration: #Configuration, updatedAt: string & !=""}
#ControlRecord: {key: string & !="", accountId: string & !="", bodyJson: string & !="", updatedAt: string & !=""}
#AccountState: {revision: int & >=1, account?: #Account, connections: [...#Connection], updatedAt: string & !=""}
#RepositorySetupRequest: {
 repository: string & =~"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
 repositoryId?: int & >=0, installationId?: int & >=0
 runnerGroupId?: int & >=0
 allowedRefs?: [...(string & =~"^refs/heads/")]
 trustedRepositoryAcknowledged: true
 publicRepositoryAcknowledged?: bool
 allowAllPullRequests?: bool
} & ({
 acceptAllMatchingRepositoryJobs: true
 publicRepositoryAcknowledged: true
 allowAllPullRequests?: false
 allowedRefs?: []
} | {
 acceptAllMatchingRepositoryJobs?: false
})
#ReconcileRequest: {hostRunId: int & >0}
#ControlCredential: {
 accountId: string & =~"^[A-Za-z0-9_-]{1,80}$"
 installationIds: [...(int & >0)]
 tokenSha256: string & =~"^[a-f0-9]{64}$"
 scopes: [...("policy:read" | "policy:write" | "repositories:write" | "operations:write" | "observations:write")]
}
#ControlCredentials: {tokens: [#ControlCredential, ...#ControlCredential]}
#Job: {
 id: int & >0, runId: int & >0, runAttempt: int & >=1
 repositoryId: int & >0, installationId: int & >0
 repository: string & !="", labels: [...string]
 action: "queued" | "in_progress" | "completed", runnerName: string
 isolatedRequired?: bool
}
#Lease: {
 id: string & !="", accountId: string & !="", offerId: string & !=""
 provider: string & !="", jobId: int & >=0, originalRunId: int & >=0
 runAttempt: int & >=0, repositoryId: int & >=0, repository: string
 installationId: int & >=0
 state: "reserved" | "dispatching" | "dispatched" | "claiming" | "running" | "uncertain" | "completed" | "cancelled"
 reservedMinutes: number & >0, reservedFreeMinutes: number & >=0
 reservedPaidMicros: int & >=0, runnerName: string, createdAt: string & !=""
 hostRunId: int & >=0, runnerId: int & >=0, actualJobId: int & >=0
 billedMinutes: number & >=0, paidMicros: int & >=0, settledAt: string, priceMicrosPerMinute: int & >=0
 freeValidUntil: string, billedFreeMinutes: number & >=0
 pipelineId?: string, result?: #PipelineResult, pipelineDigest?: string
 usageCompletedAt?: string
 sandboxName?: string, sandboxSessionId?: string, sandboxCommandId?: string
 sandboxStage?: "" | "pending" | "creating" | "created" | "registering" | "starting" | "running" | "stopping" | "stopped"
 sandboxPricing?: #SandboxPricing
 sandboxReservedAllowance?: #SandboxAllowance
 sandboxUsedAllowance?: #SandboxAllowance
 proxySandboxName?: string, proxySandboxSessionId?: string, proxySandboxCommandId?: string
 proxySandboxStage?: "" | "creating" | "created" | "starting" | "running" | "stopping" | "stopped"
 sandboxStoppedUsage?: #SandboxMeasuredUsage
 proxyStoppedUsage?: #SandboxMeasuredUsage
 sandboxStopFromStage?: "" | "pending" | "created" | "registering" | "starting" | "running"
 runnerDeletionConfirmed?: bool
}
#CiEvent: {type: string & !="", accountId: string, leaseId: string, at: string & !="", detail: string}
#Snapshot: {leases: [...#Lease], events: [...#CiEvent]}

#Ci: #SandboxMeasuredUsage | #SandboxAllowance | #SandboxPricing | #DesiredCiPolicy | #BudgetSignal | #BudgetRoutingPolicy | #Offer | #Account | #Connection | #Configuration | #ConfigurationState | #ControlRecord | #AccountState | #RepositorySetupRequest | #ReconcileRequest | #ControlCredential | #ControlCredentials | #Job | #Lease | #CiEvent | #Snapshot | #PipelineStep | #Pipeline | #PipelineStepResult | #PipelineArtifact | #PipelineResult

#PipelineStep: {id: string & !="", argv: [string & !="", ...string], cwd: string, env: [string & !="__proto__"]: string}
#Pipeline: {
 id: string & =~"^[A-Za-z0-9_-]{1,100}$"
 accountId: string & !=""
 steps: [#PipelineStep, ...#PipelineStep]
 artifactPaths: [...string]
 timeoutSeconds: int & >=1 & <=19800
 requiredCapabilities: [...("commands" | "artifacts" | "cancellation")]
}
#PipelineStepResult: {id: string & !="", exitCode: int & >=0 & <=255, stdout: string, stderr: string}
#PipelineArtifact: {path: string & !="", data: string, sha256: string & =~"^[a-f0-9]{64}$"}
#PipelineResult: {
 id: string & !="", backend: "" | "gh-actions" | "dagger" | "cf" | "ado"
 status: "succeeded" | "failed" | "cancelled" | "timed_out" | "uncertain" | "blocked"
 steps: [...#PipelineStepResult], artifacts: [...#PipelineArtifact], error: string
}

#BudgetSignalData: {
 tenantId: string & !=""
 thresholdFraction: number & >0 & <=1
 thresholdUsd: number & >=0
 budgetUsd: number & >0
 netSpentUsd: number
 cycle: int & >0 & <=4294967295
 signalKey: string & =~"^budget:"
}
#BudgetSignal: {type: "budget.ThresholdCrossed" | "budget.Recovered", data: #BudgetSignalData}
#BudgetRoutingRule: {thresholdFraction: number & >0 & <=1, offerIds: [...(string & !="")]}
#BudgetRoutingPolicy: {
 accountId: string & !="", tenantId: string & !=""
 normalOfferIds: [...(string & !="")]
 thresholds: [#BudgetRoutingRule, ...#BudgetRoutingRule]
}

// Desired policy does not contain runtime-owned balances, observations or leases.
#CiPolicyProvider: {
 id: string & =~"^[A-Za-z0-9_-]{1,80}$"
 kind: "github" | "blacksmith" | "depot" | "warpbuild" | "kubernetes" | "local" | "vercel" | "azure-devops"
 connectionRef: string & !=""
 runsOn: string & =~"^[A-Za-z0-9_.-]{1,100}$"
 enabled?: bool
 if kind == "local" {runsOn: "hobo-local-host"}
}
#CiPolicyPool: {label: "hobo", os: "linux", architecture: "x64"}
#CiPolicyBudget: {scope: "ci-account", currency: "USD", limitMicros?: int & >=0 & <=9007199254740991, period: "manual", timeZone: "UTC"}
#CiPolicyThreshold: {fraction: number & >0 & <=1, allow?: [...(string & =~"^[A-Za-z0-9_-]{1,80}$")]}
#CiPolicyRouting: {strategy: "lowest-total-incremental-cost", noEligibleProvider: "queue", unknownAllocation: "zero"}
#DesiredCiPolicy: {
 accountId: string & =~"^[A-Za-z0-9_-]{1,80}$"
 tenantId: string & =~"^[A-Za-z0-9_-]{1,80}$"
 pool: #CiPolicyPool
 providers: [#CiPolicyProvider, ...#CiPolicyProvider]
 budget: #CiPolicyBudget
 routing: #CiPolicyRouting
 thresholds?: [...#CiPolicyThreshold]
}

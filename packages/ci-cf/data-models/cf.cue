package readiness

#Readiness: {
 integration: "cf"
 status: "implemented"
 executionAvailable: true
 targetSdk: "@cloudflare/ci"
 targetDocumentation: "https://github.com/cloudflare/ci"
 pendingGates: [string & =~"\\S", ...string & =~"\\S"]
}

#CommandEnvelope: {
 exitCode: int & >=0 & <=255
 stdoutBase64: string & =~"^[A-Za-z0-9+/]*={0,2}$"
 stderrBase64: string & =~"^[A-Za-z0-9+/]*={0,2}$"
}
#LocalPreparation: {
 id: string & =~"^local-[A-Za-z0-9_-]+$"
 sourceSha: string & =~"^([a-f0-9]{40}|[a-f0-9]{64})$"
 pipelineJson: string & =~"\\S"
 pipelineSha256: string & =~"^[a-f0-9]{64}$"
 archiveSha256: string & =~"^[a-f0-9]{64}$"
 dockerfileSha256: string & =~"^[a-f0-9]{64}$"
 configSha256: string & =~"^[a-f0-9]{64}$"
 port: int & >=1 & <=65535
 runtimeSha256: string & =~"^[a-f0-9]{64}$"
 bundleSha256: string & =~"^[a-f0-9]{64}$"
}
#LocalHealth: {
 preparationId: string & =~"^local-[A-Za-z0-9_-]+$"
 sourceSha: string & =~"^([a-f0-9]{40}|[a-f0-9]{64})$"
 pipelineSha256: string & =~"^[a-f0-9]{64}$"
}
#LocalRunState: {
 phase: "new" | "ready" | "running" | "stopping" | "finished"
 resultStatus?: "" | "succeeded" | "failed" | "cancelled" | "timed_out" | "uncertain"
 workflowStatus?: "" | "complete" | "errored" | "terminated"
 stopReason?: "" | "cancelled" | "timed_out" | "fault"
 shutdownConfirmed?: bool
 outcome?: "" | "succeeded" | "failed" | "cancelled" | "timed_out" | "uncertain"
 exitCode?: int & >=0 & <=130
 if phase == "finished" {
   outcome: "succeeded" | "failed" | "cancelled" | "timed_out" | "uncertain"
 }
 if outcome != _|_ {
 if outcome == "failed" {exitCode: 1}
 if outcome == "uncertain" {exitCode: 2}
 if outcome == "cancelled" {exitCode: 130}
 if outcome == "timed_out" {exitCode: 124}
 if outcome == "succeeded" {
   phase: "finished"
   resultStatus: "succeeded"
   workflowStatus: "complete"
   shutdownConfirmed: true
   exitCode?: 0
   stopReason?: ""
 }
 }
}
#LocalNativeStatus: {
 status: "queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waiting" | "waitingForPause" | "unknown"
 error?: string
}
#LocalRunEvent: {
 kind: "ready" | "submitted" | "result" | "terminal" | "cancelled" | "timed_out" | "fault" | "shutdown" | "shutdown_failed"
 status?: "" | "succeeded" | "failed" | "cancelled" | "timed_out" | "uncertain" | "complete" | "errored" | "terminated"
}
#LocalRunReceipt: {
 workflowId: string & =~"^[a-f0-9-]{36}$"
 preparationId: string & =~"^local-[A-Za-z0-9_-]+$"
 sourceSha: string & =~"^([a-f0-9]{40}|[a-f0-9]{64})$"
 pipelineSha256: string & =~"^[a-f0-9]{64}$"
 startedAt: string & =~"\\S"
 finishedAt?: string
 state: #LocalRunState
 resultJson?: string
 error?: string
 ownedContainers?: [...string]
 dockerHost?: string & =~"^unix://"
 dockerId?: string & =~"\\S"
}
#Cf: #Readiness | #CommandEnvelope | #LocalPreparation | #LocalHealth | #LocalNativeStatus | #LocalRunState | #LocalRunEvent | #LocalRunReceipt

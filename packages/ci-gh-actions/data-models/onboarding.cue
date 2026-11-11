package ghactions

import "list"

#JitBootstrapResponse: {encodedJitConfig: string & =~"^[A-Za-z0-9+/=]+$"}
#OnboardingPrincipal: {accountId: string & =~"^[A-Za-z0-9_-]{1,80}$", installationIds: [number & >0, ...number & >0]}
#OnboardingFile: {path: ".github/workflows/hobo-ci-host.yml" | ".hobo-ci/bootstrap.mts", content: string & !="", sha256: string & =~"^[a-f0-9]{64}$"}
#OnboardingPlan: {
	accountId: string & =~"^[A-Za-z0-9_-]{1,80}$"
	installationId: number & >0
	repository: string & =~"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
	repositoryId: number & >0
	defaultBranch: string & !=""
	baseSha: string & =~"^[a-f0-9]{40}$"
	baseTreeSha: string & =~"^[a-f0-9]{40}$"
	installBranch: string & =~"^hobo-ci-install-[a-f0-9]{20}$"
	bridgeRef: string & =~"^hobo-ci-bridge-[a-f0-9]{20}$"
	bridgeWorkflow: "hobo-ci-host.yml"
	runnerGroupId: int & >0
	dispatcherActorId: number & >0
	trustedRefs: [string & =~"^refs/heads/.+", ...string & =~"^refs/heads/.+"]
	publicRepoAcknowledged?: bool
	allowAllPullRequests?: bool
	trustedRepositoryAcknowledged: true
	files: [#OnboardingFile, #OnboardingFile]
	relayUrl: string & =~"^https://[^/]+/?$"
	planDigest: string & =~"^[a-f0-9]{64}$"
}
#OnboardingApplyResult: {status: "pending", pullRequestNumber: number & >0, pullRequestUrl: string & =~"^https://github.com/", branch: string & =~"^hobo-ci-install-[a-f0-9]{20}$", commitSha: string & =~"^[a-f0-9]{40}$", planDigest: string & =~"^[a-f0-9]{64}$"}
#OnboardingOperation: {id: string & !="", plan: #OnboardingPlan, result?: #OnboardingApplyResult, status: "open" | "planned" | "applying" | "pending" | "uncertain" | "ready"}
#GithubAppHookAttributes: {url: string & =~"^https://", active: true}
#GithubAppManifest: {
	name: string & !=""
	url: string & =~"^https://"
	hook_attributes: #GithubAppHookAttributes
	redirect_url: string & =~"^https://"
	setup_url: string & =~"^https://"
	callback_urls: [string & =~"^https://", ...string & =~"^https://"]
	public?: bool
	default_events: ["workflow_job", "workflow_run"]
	default_permissions: {actions: "write", administration: "write", contents: "write", workflows: "write", metadata: "read", pull_requests: "write", members: "read"}
}
// Third-party runner integration declared in .hobo/ci.json. References only:
// secretRef names a GitHub secret or env var; raw credential values never fit.
#RunnerIntegrationAuth: {
 method: "github-app" | "oidc" | "device" | "secret-ref"
 secretRef?: string & =~"^(github-secret|env):[A-Z][A-Z0-9_]{0,63}$"
 projectId?: string & =~"^[a-z0-9]{6,32}$"
 if method == "secret-ref" {secretRef: string}
 if method == "oidc" {projectId: string}
}
#RunnerIntegration: {
 id: string & =~"^[A-Za-z][A-Za-z0-9_-]{0,63}$"
 provider: "blacksmith" | "depot" | "jog" | "boat"
 enabled?: bool
 organization?: string & =~"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$"
 runsOn: [string & =~"^[a-z0-9][a-z0-9.-]{0,63}$", ...string & =~"^[a-z0-9][a-z0-9.-]{0,63}$"]
 auth: #RunnerIntegrationAuth
 if provider == "blacksmith" {auth: method: "github-app", runsOn: [...=~"^blacksmith(-[a-z0-9]+)*$"]}
 if provider == "jog" {auth: method: "github-app", runsOn: [...=~"^jog(-[a-z0-9]+)*$"]}
 if provider == "depot" {auth: method: "github-app" | "oidc" | "secret-ref", runsOn: [...=~"^depot-[a-z0-9.-]+$"]}
 if provider == "boat" {auth: method: "device" | "secret-ref", runsOn: [...=~"^boat(-(small|large|xlarge))?$"]}
}
// Views the relay's MCP server returns. Protobuf JSON leaves out a zero or
// empty field, so only what identifies a view is required.
#RelayMcpLease: {
 id: string & =~"^[a-f0-9-]{36}$"
 state: string & !=""
 active?: bool
 repository?: string
 jobId?: int & >=0, jobName?: string, runId?: int & >=0, runAttempt?: int & >=0
 provider?: string, offerId?: string, runnerName?: string
 createdAt?: string, dispatchingAt?: string, settledAt?: string, queueDeadlineAt?: string
 hostRunId?: int & >=0, actualJobId?: int & >=0
 billedMinutes?: number & >=0, paidMicros?: number & >=0
 memoryClass?: "" | "light" | "standard" | "heavy"
 sandboxStage?: string
}
#RelayMcpJob: {
 id: int & >0, runId: int & >0, runAttempt?: int & >=0
 repository: string & !=""
 name?: string, labels?: [...string], isolatedRequired?: bool
 memoryClass?: "" | "light" | "standard" | "heavy"
 queueDeadlineAt?: string
}
#RelayMcpEvent: {
 cursor: string & =~"^[A-Za-z0-9_-]{22}$"
 type: string & =~"^ci\\.[A-Za-z]+$"
 at: string & !=""
 leaseId?: string, state?: string, repository?: string
 jobId?: int & >=0, jobName?: string, runId?: int & >=0, runAttempt?: int & >=0
}
#RelayMcpLeases: {leases?: [...#RelayMcpLease], truncated?: bool}
#RelayMcpLeaseDetail: {lease: #RelayMcpLease, events?: [...#RelayMcpEvent]}
#RelayMcpJobs: {jobs?: [...#RelayMcpJob], truncated?: bool}
#RelayMcpEvents: {events?: [...#RelayMcpEvent], cursor: string & =~"^[A-Za-z0-9_-]{22}$", timedOut?: bool, more?: bool, truncated?: bool}
#RelayMcpEngine: {id: string & =~"^[a-z0-9-]{1,40}$", ready?: bool}
#RelayMcpStatus: {ready?: bool, engines: [#RelayMcpEngine, ...#RelayMcpEngine], subscriptions?: bool, waitDefaultSeconds: int & >=1, waitMaxSeconds: int & >=1, accountCalls: int & >=1, accountWaits: int & >=1, requestMessages: int & >=1, mesh?: "configured" | "not-configured"}
#RelayMcpQuarantinedDelivery: {deliveryId: string & =~"^[A-Za-z0-9-]{1,100}$", event: string & !="", installationId: int & >0, repositoryId: int & >0, receivedAt: string & !="", attempts?: int & >=0}
#RelayMcpQuarantine: {deliveries?: [...#RelayMcpQuarantinedDelivery]}
#RelayMcpRetry: {deliveryId: string & =~"^[A-Za-z0-9-]{1,100}$", status: "queued"}
#MeshRepository: string & =~"^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$"
#MeshNodeId: string & =~"^[A-Za-z0-9_-]{1,64}$"
#MeshPublicKey: string & =~"^[A-Za-z0-9_-]{43}$"
#MeshLabel: string & =~"^.{1,80}$"
#MeshFree: {memoryMb?: int & >=0 & <=16777216, diskMb?: int & >=0 & <=1073741824}
#MeshPlatform: {os: string & =~"^.{1,32}$", arch: string & =~"^.{1,32}$"}
#MeshReliabilitySamples: {delivered?: number & >=0, dropped?: number & >=0}
#MeshIdentityProof: {publicKey: #MeshPublicKey, signature: string & =~"^[A-Za-z0-9_-]{86}$"}
#MeshAdvert: {
	id: #MeshNodeId
	freeSlots: int & >=0 & <=4096
	totalSlots?: int & >=0 & <=4096
	healthy: bool
	labels: [...#MeshLabel] & list.MaxItems(32)
	validUntilMs: int & >=0
	free?: #MeshFree
	platform?: #MeshPlatform
	reliability?: number & >=0 & <=1
	samples?: #MeshReliabilitySamples
	sinceMs?: int & >=0
	identity?: #MeshIdentityProof
	repository?: "" | #MeshRepository
}
#MeshTrustedKey: {publicKey: #MeshPublicKey, nodeId?: "" | #MeshNodeId}
#MeshTrustConfig: {trustedKeys: [...#MeshTrustedKey] & list.MaxItems(256), requireTrusted?: bool}
#MeshReliabilityRecord: {delivered: number & >=0, dropped: number & >=0, atMs: number & >=0, resetToken?: string & =~"^[A-Za-z0-9._:-]{0,64}$"}
#MeshNodeReport: {
	id: #MeshNodeId
	state: "live" | "unhealthy" | "lost"
	since?: string
	healthy?: bool
	lastSeenAt?: string
	validUntil: string & !=""
	totalSlots?: int & >=0 & <=4096
	freeSlots?: int & >=0 & <=4096
	freeMemoryMb?: int & >=0
	freeDiskMb?: int & >=0
	platform?: #MeshPlatform
	labels?: [...#MeshLabel]
	trust: "trusted" | "unverified" | "invalid"
	publicKey?: "" | #MeshPublicKey
	reliability?: number & >=0 & <=1
	delivered?: number & >=0
	dropped?: number & >=0
	repository?: "" | #MeshRepository
}
#MeshCapacitySummary: {nodes?: int & >=0, healthy?: int & >=0, available?: int & >=0, totalSlots?: int & >=0, freeSlots?: int & >=0, freeMemoryMb?: int & >=0, largestFreeMemoryMb?: int & >=0, freeDiskMb?: int & >=0}
#MeshNodeReports: {mesh: "configured" | "not-configured" | "unreachable", nodes?: [...#MeshNodeReport], capacity?: #MeshCapacitySummary, readAt?: string, requireTrusted?: bool, truncated?: bool}
#MeshFleetLabelState: {nodes?: int & >=0, trustedNodes?: int & >=0, freeSlots?: int & >=0}
#MeshFleetState: {publishedAt: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$", labels: {[=~"^[A-Za-z0-9_.-]{1,80}$"]: #MeshFleetLabelState}}
#Onboarding: #JitBootstrapResponse | #OnboardingPrincipal | #OnboardingFile | #OnboardingPlan | #OnboardingApplyResult | #OnboardingOperation | #GithubAppHookAttributes | #GithubAppManifest | #RunnerIntegration | #RelayMcpLease | #RelayMcpJob | #RelayMcpEvent | #RelayMcpLeaseDetail | #RelayMcpEvents | #RelayMcpStatus | #RelayMcpQuarantinedDelivery | #RelayMcpRetry | #MeshAdvert | #MeshTrustConfig | #MeshReliabilityRecord | #MeshNodeReports | #MeshFleetState

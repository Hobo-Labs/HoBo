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
#RelayCacheJobKey: string & =~"^[0-9]{1,16}:[0-9]{1,16}:[0-9]{1,10}$"
#RelayCacheLeaseId: string & =~"^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
#RelayCacheIntent: {kind: "ci.DispatchRequested" | "ci.RunnerClaimed" | "ci.SandboxCreated", at: string & !=""}
#RelayCacheLease: {leaseJson: string & =~"^\\{", jobKey: #RelayCacheJobKey, generation?: int & >=0 & <=64, intents?: [...#RelayCacheIntent] & list.MaxItems(3), rebuiltFrom?: "runner" | "bridge-run" | "sandbox"}
#RelayCacheAssignment: {leaseId: #RelayCacheLeaseId, version: string & =~"^[0-9a-f-]{36}$"}
#RelayCacheJob: {
	jobKey: #RelayCacheJobKey
	state: "pending" | "taken" | "idle" | "terminal"
	generation?: int & >=0 & <=64
	leaseId?: #RelayCacheLeaseId
	pendingJobJson?: string & =~"^\\{"
	firstSeenAt: string & !=""
	queueDeadlineAt?: string
	assigned?: #RelayCacheAssignment
	terminalReason?: "completed" | "expired"
}
#RelayCacheInflightEntry: {leaseId: #RelayCacheLeaseId, jobKey: string & !="", offerId: string & !="", provider: string & !="", providerAccountId?: string, reservedPaidMicros?: number & >=0, reservedFreeMinutes?: number & >=0, reservedMinutes?: number & >=0, sandboxReservedAllowanceJson?: string, createdAt: string & !=""}
#RelayCacheInflight: {accountId: string & =~"^[A-Za-z0-9_-]{1,80}$", entries?: [...#RelayCacheInflightEntry] & list.MaxItems(1000), recentTerminal?: [...#RelayCacheLeaseId] & list.MaxItems(50), holdsKnown?: bool, rebuiltAt?: string}
#RelayCachePending: {jobKeys?: [...#RelayCacheJobKey] & list.MaxItems(2000)}
#RelayCacheDelivery: {fingerprint: string & =~"^[a-f0-9]{64}$", receivedAt: string & !="", ignored?: bool}
#RelayCacheSandboxEgress: {leaseId: #RelayCacheLeaseId, accountId: string & =~"^[A-Za-z0-9_-]{1,80}$", maxBytes?: number & >=0}
#RelayCacheAccountId: string & =~"^[A-Za-z0-9_-]{1,80}$"
#RelayCacheWebhookScan: {cursorUrl?: string & =~"^https://api\\.github\\.com/app/hook/deliveries\\?", checkpointAt: string & !=""}
#RelayCacheQueuedCursor: {page?: int & >=1 & <=1000, runs?: [...(int & >0)] & list.MaxItems(100), loaded?: bool, hasNext?: bool, runIndex?: int & >=0 & <=100, jobPage?: int & >=1 & <=1000, jobIndex?: int & >=0 & <=100}
#RelayCacheQueuedScan: {cursor: #RelayCacheQueuedCursor, dueMs?: number & >=0, touchedMs?: number & >=0}
// Sealed records carry ciphertext only: no account, token or verifier field.
#RelayCacheSealed: close({keyId: string & =~"^[a-f0-9]{16}$", nonce: string & !="", ciphertext: string & !=""})
// Sealed payloads: never stored in the clear, so outside the stored union.
#RelayCacheOAuthState: {browserDigest: string & =~"^[a-f0-9]{64}$", accountId: #RelayCacheAccountId, verifier: string & !="", controlToken: string & !="", expiresAtMs: number & >0}
#RelayCacheOAuthSession: {accountId: #RelayCacheAccountId, githubId: number & >0, githubToken: string & !="", controlToken: string & !="", expiresAtMs: number & >0}
#RelayCacheOwnerSession: {accountId: #RelayCacheAccountId, expiresAtMs: number & >0}
#RelayCacheAppState:{purpose: "register" | "install", accountId: #RelayCacheAccountId, subject: string & !="", expiresAtMs: number & >0}
#RelayCacheVerifiedInstallations: {accountId: #RelayCacheAccountId, appId: number & >0, verifiedIds?: [...(number & >0)] & list.MaxItems(100)}
#RelayCacheProxyMeter: {leaseId: #RelayCacheLeaseId, proxySessionId: string & =~"^sbx_[A-Za-z0-9_-]+$", bytes?: number & >=0, calls?: number & >=0, readAt: string & !=""}
#Onboarding: #JitBootstrapResponse | #OnboardingPrincipal | #OnboardingFile | #OnboardingPlan | #OnboardingApplyResult | #OnboardingOperation | #GithubAppHookAttributes | #GithubAppManifest | #RunnerIntegration | #RelayMcpLease | #RelayMcpJob | #RelayMcpEvent | #RelayMcpLeaseDetail | #RelayMcpEvents | #RelayMcpStatus | #RelayMcpQuarantinedDelivery | #RelayMcpRetry | #RelayCacheLease | #RelayCacheJob | #RelayCacheInflight | #RelayCachePending | #RelayCacheDelivery | #RelayCacheSandboxEgress | #RelayCacheWebhookScan | #RelayCacheQueuedScan | #RelayCacheSealed | #RelayCacheAppState | #RelayCacheVerifiedInstallations | #RelayCacheProxyMeter

package ghactions
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
#Onboarding: #JitBootstrapResponse | #OnboardingPrincipal | #OnboardingFile | #OnboardingPlan | #OnboardingApplyResult | #OnboardingOperation | #GithubAppHookAttributes | #GithubAppManifest | #RunnerIntegration

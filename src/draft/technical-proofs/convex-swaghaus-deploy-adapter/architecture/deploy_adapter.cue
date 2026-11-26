// CUE constraints for every protobuf type in deploy_adapter.proto: formats,
// ranges, cross-field agreements, and the allowed ship state transitions.
// src/parse.ts is the executable mirror of these constraints — when one
// changes, the other must change with it.

package convex_swaghaus_deploy_adapter

// ---- formats ----------------------------------------------------------

// Env var names only (presence-only preflight); values never appear here.
#EnvName: string & =~"^[A-Z][A-Z0-9_]*$"

// Convex deployment names are used as a DNS label in the Cloud URL.
#DeploymentName: string & =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"

// Convex Cloud deployment URL: https://<deployment-name>.convex.cloud
#CloudDeploymentUrl: string & =~"^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.convex\\.cloud$"

// Self-hosted backend URL: any absolute http(s) origin (optionally a port and
// path), and never a convex.cloud host — that host IS Convex Cloud.
#SelfHostedUrl: string & =~"^https?://[A-Za-z0-9._:\\[\\]-]+(/[^[:space:]]*)?$" & !~"\\.convex\\.cloud(:|/|$)"

// Repo-relative Convex app directory: no absolute paths, no `..` escape
// (mirrors resolveConvexRoot's escape guard in @hobo/convex).
#RepoRelativePath: string & =~"^[A-Za-z0-9._][A-Za-z0-9._/-]*$" & !~"(^|/)\\.\\.(/|$)"

// ---- enums ------------------------------------------------------------

#DeployMode: "cloud" | "self-hosted" | "mock"

#ImpedanceSeverity: "info" | "warn" | "block"

// ---- messages ---------------------------------------------------------

#DeployPreflight: {
	live: bool
	missing: [...#EnvName]
	remediation: string & !=""
	mode:        #DeployMode

	// A ship is live only when nothing is missing AND the caller did not ask
	// for the explicit mock lane: mock never claims live credentials.
	_live_agreement: true & (live == (len(missing) == 0 && mode != "mock"))
}

#ConvexDeployRequest: {
	root:            #RepoRelativePath
	deployment_name: #DeploymentName
	mock:            bool
	// proto3 scalar: absent self-host URL is the empty string.
	self_hosted_url:           #SelfHostedUrl | ""
	has_deploy_key:            bool
	has_self_hosted_admin_key: bool

	// Fail-closed credential rule from deploy.ts: a non-mock deploy needs a
	// Cloud deploy key, or BOTH the self-hosted URL and its admin key.
	if !mock {
		_credentialed: true & (has_deploy_key ||
			(self_hosted_url != "" && has_self_hosted_admin_key))
	}

	// A self-hosted admin key without its URL cannot address a backend.
	if has_self_hosted_admin_key {
		self_hosted_url: #SelfHostedUrl
	}
}

#ConvexDeployReceipt: {
	// The executor either returns ok or throws; a receipt is never a failure.
	ok:              true
	deployment_url:  #CloudDeploymentUrl | #SelfHostedUrl
	deployment_name: #DeploymentName
	mocked:          bool
	mode:            #DeployMode

	// The mock lane is explicit and self-declaring in both fields.
	_mock_agreement: true & ((mode == "mock") == mocked)

	// Mode decides which URL family is admissible: only Cloud deployments may
	// claim a convex.cloud host.
	if mode == "cloud" {
		deployment_url: #CloudDeploymentUrl
	}
	if mode == "self-hosted" {
		deployment_url: #SelfHostedUrl
	}
}

#ImpedanceFindingRecord: {
	code:     "paradigm-mismatch" | "no-control-plane-time-travel" | "ts-js-runtime-only" | "occ-contention"
	severity: #ImpedanceSeverity
	message:  string & !=""

	// impedance.ts blocks on exactly one code; the rest are info/warn evidence.
	_block_only_on_paradigm: true & ((severity == "block") == (code == "paradigm-mismatch"))
}

// ---- allowed state transitions ---------------------------------------

// The ship lifecycle src/ship.ts walks. `refused` is terminal and reachable
// from every pre-deploy phase (fail-closed); `deployed` is terminal.
#ShipPhase: "requested" | "preflighted" | "deploying" | "deployed" | "refused"

#ShipTransitions: {
	[#ShipPhase]: [...#ShipPhase]

	requested: ["preflighted", "refused"]
	preflighted: ["deploying", "refused"]
	deploying: ["deployed", "refused"]
	deployed: []
	refused: []
}

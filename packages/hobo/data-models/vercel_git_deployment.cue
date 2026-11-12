package hobo

// The package's fixture gate accepts the git-deployment plan record.
#VercelGitDeployment: #VercelGitDeploymentPlan

// The config service's coordinates: where a deployment signs in and what it
// reads, never what it signs in with. Plain configuration, so a plan may carry
// them (CONFIG_SERVICE_COORDINATES in src/vercel-env-policy.ts).
#ConfigServiceCoordinate: "INFISICAL_ENVIRONMENT" | "INFISICAL_IDENTITY_ID" | "INFISICAL_PROJECT_ID" | "INFISICAL_SECRET_PATH" | "INFISICAL_SITE_URL"

// A name that says it holds a credential, that a storage integration owns, or
// that belongs to the config service without being one of its coordinates.
// The plan must never carry one as a setting (src/vercel-env-policy.ts refuses
// it before the record is formed; this is the same rule, restated on the wire).
#PlainSettingName: =~"^[A-Za-z_][A-Za-z0-9_]{0,255}$" &
	!~"(?i)(TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|APIKEY)" &
	!~"(?i)(^|_)(PASSWD|PASSPHRASE|PWD|CREDS|KEYS?|AUTH|AUTHORIZATION|BEARER|COOKIE|DSN|SIGNATURE|SALT|CERT|PEM)(_|$)" &
	!~"(?i)^(DATABASE|POSTGRES|PG[A-Z]*|REDIS|MONGO[A-Z]*|MYSQL|KV|BLOB|EDGE_CONFIG|TURSO|LIBSQL|UPSTASH|VALKEY|INFISICAL)(_|$)" &
	!~"^ConnectionStrings__"

#NonSecretSettingName: #ConfigServiceCoordinate | #PlainSettingName

// A value with credentials in a URL, a bearer header or a private key is not
// configuration.
#NonSecretSettingValue: string &
	!~"://[^/\\s]*:[^@/\\s]+@" &
	!~"(?i)\\bbearer\\s+\\S" &
	!~"-----BEGIN [A-Z ]*PRIVATE KEY-----"

#VercelPlanSetting: {
	key:    #NonSecretSettingName
	value?: #NonSecretSettingValue
}

#VercelPlanResource: {
	kind: string & !=""
	name: string & !=""
}

// The commit Vercel builds. GitHub only: the client forms no other source.
#VercelPlanGitSource: {
	type:           "github"
	org:            =~"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$"
	repo:           =~"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$"
	ref:            =~"^[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$"
	sha?:           =~"^[0-9a-f]{40}$"
	rootDirectory?: =~"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$"
}

#VercelPlanRequest: {
	method: "GET" | "POST" | "PATCH"
	path:   =~"^/v[0-9]+/[A-Za-z0-9._/%-]+(\\?teamId=team_[A-Za-z0-9]+)?$"
	body?:  string
	when:   string & !=""
}

#VercelPlanPlacement: {
	yard:     string & !=""
	camp:     =~"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$"
	provider: string & !=""
	regions?: [...(string & !="")]
}

// A capability profile id (ADR-0151 grammar).
#ProfileId: =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"

#VercelPlanBinding: {
	profile:         #ProfileId
	productId?:      string
	connectivityId?: string
	selected?:       bool
	settings?: [...#NonSecretSettingName]
	inputs?: [...#NonSecretSettingName]
	provisioning?: "" | =~"^marketplace:[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)?$"
}

// The Vercel CLI as the provisioning step runs it: `integration` subcommands
// only, and no argument that carries a token (`--token` or `-t`).
#VercelPlanCliCommand: {
	args: ["integration", ...(string & !="" & !~"^(--token|-t)(=|$)")]
	when: string & !=""
}

#VercelGitDeploymentPlan: {
	schemaVersion: "hobo.vercel-git-deployment-plan/v1"
	bindle:        string & !=""
	// At least one resource, and at least one request.
	resources: [#VercelPlanResource, ...#VercelPlanResource]
	project: =~"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"
	scope:   "token-default" | =~"^team_[A-Za-z0-9]+$"
	// Production is never implied: the record says which.
	target: "preview" | "production"
	gitSource: #VercelPlanGitSource
	createMissingProject?: bool
	settings?: [...#VercelPlanSetting]
	operatorSecrets?: [...(string & !="")]
	requests: [#VercelPlanRequest, ...#VercelPlanRequest]
	// The Yard and Camp the plan was formed from, and the Yard's rows.
	placement: #VercelPlanPlacement
	bindings: [#VercelPlanBinding, ...#VercelPlanBinding]
	provisioning?: [...#VercelPlanCliCommand]
}

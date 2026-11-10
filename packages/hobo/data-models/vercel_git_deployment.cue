package hobo

// The package's fixture gate accepts the git-deployment plan record.
#VercelGitDeployment: #VercelGitDeploymentPlan

// A name that says it holds a credential, or that a storage integration owns.
// The plan must never carry one as a setting (src/vercel-env-policy.ts refuses
// it before the record is formed; this is the same rule, restated on the wire).
#NonSecretSettingName: =~"^[A-Za-z_][A-Za-z0-9_]{0,255}$" &
	!~"(?i)(TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|APIKEY)" &
	!~"(?i)(^|_)(PASSWD|PASSPHRASE|PWD|CREDS|KEYS?|AUTH|AUTHORIZATION|BEARER|COOKIE|DSN|SIGNATURE|SALT|CERT|PEM)(_|$)" &
	!~"(?i)^(DATABASE|POSTGRES|PG[A-Z]*|REDIS|MONGO[A-Z]*|MYSQL|KV|BLOB|EDGE_CONFIG)(_|$)" &
	!~"^ConnectionStrings__"

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
}

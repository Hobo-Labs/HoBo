package secret_store_claim

// Constraints for the secret store a deploy chooses (ADR-0179 amendment,
// 2026-11-12). Field names are the protobuf JSON names.

#Kind: "auth-md" | "cloudflare-temporary" | "infisical-self-hosted" | "infisical-cloud-attach" | "1password-attach" | "bitwarden-attach"

#Https: string & =~"^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$"

#Id: string & =~"^[A-Za-z0-9_-]{1,64}$"

#SecretStoreOffer: {
	kind:       #Kind
	preference: int & >=1 & <=16
	claimMechanism: "auth-md-claim" | "provider-claim-url" | "hobo-sealed-claim" | "owner-sign-in"
	claimWindowMinutes?: int & >=0 & <=10080
	runtimeBinding:      "built" | "designed"
	cost:                string & =~"^.{1,400}$"
	availability:        string & =~"^.{1,400}$"
	sourceUrl:           #Https
	checkedAt:           string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
	provider:            "auth-md" | "cloudflare" | "infisical" | "1password" | "bitwarden"
	runtimeAuth:         "workload-identity" | "stored-token"
	// A provider claim URL has a deadline; HoBo's sealed claim sets its own.
	if claimMechanism == "provider-claim-url" {claimWindowMinutes: >0}
}

#SecretStoreEvidence: {
	kind:      #Kind
	available: bool
	detail?:   string & =~"^[^\\n]{0,200}$"
	// An unavailable offer says why.
	if !available {detail: !=""}
}

#SecretStoreSkip: {
	kind:   #Kind
	reason: string & !=""
}

#SecretStoreSelection: {
	capability:   "secrets.config-service/v1"
	selectedKind: #Kind
	skipped?: [...{kind: #Kind, reason: string & !=""}]
	decidedAt: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
}

// The committed binding: coordinates only. A value that looks like a
// credential (a URL with userinfo, a token prefix) cannot be a field.
#SecretStoreBinding: {
	kind:        #Kind
	endpoint:    #Https & !~"@"
	projectId:   #Id
	environment: string & =~"^[a-z0-9][a-z0-9_-]{0,63}$"
	secretPath:  string & =~"^/([A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*)?$"
	relayIdentityId:  #Id
	deployIdentityId: #Id & !=relayIdentityId
	vercelTeamId?:    string & =~"^team_[A-Za-z0-9]{1,64}$"
	claimBundleId:    string & =~"^[a-z0-9][a-z0-9:._-]{0,127}$"
	claimState:       "pending" | "claimed"
	// Apart from the relay's project: the relay identity cannot read it.
	// Optional: a separate project for deploy-time credentials, empty when the
	// default path needs none (ADR-0179 amendment "Secretless first").
	deployProjectId?: #Id & !=projectId
	// The exact subject the deploy identity trusts: GitHub's prefix for the
	// repository, then the branch. Never a glob (a recycled name would match).
	deployOidcSubject?: #GithubSubjectPrefix & =~":ref:refs/heads/[A-Za-z0-9._/-]{1,200}$"
}

// `repo:<owner>/<repo>` (legacy) or `repo:<owner>@<ownerId>/<repo>@<repoId>`
// (immutable): no wildcard.
#GithubSubjectPrefix: string & =~"^repo:[A-Za-z0-9-]{1,39}(@[0-9]{1,20})?/[A-Za-z0-9._-]{1,100}(@[0-9]{1,20})?" & !~"[*?]"

// GitHub's REST answers, the fields read (JSON names as GitHub sends them).
#GithubRepository: {
	id:   int & >0
	name: string & =~"^[A-Za-z0-9._-]{1,100}$"
	owner: #GithubRepositoryOwner
	...
}

#GithubRepositoryOwner: {
	login: string & =~"^[A-Za-z0-9-]{1,39}$"
	id:    int & >0
	...
}

#GithubOidcSubjectTemplate: {
	use_default: bool
	include_claim_keys?: [...string & =~"^[A-Za-z0-9_]{1,64}$"]
	use_immutable_subject?: bool
	sub_claim_prefix?:      #GithubSubjectPrefix & =~"^[^:]+:[^:]+$"
	...
}

// The flat fixture corpus holds bindings.
#SecretStoreClaim: #SecretStoreBinding

// CUE constraints for every protobuf type in data-models/hobo_ci.proto.
package hobo_ci

#SecretStore: "infisical" | "1password"

#GithubConnectionConfig: {
	relayUrl:    =~"^https://[^/?#]+$"
	owner:       =~"^[A-Za-z0-9-]{1,39}$"
	ownerId:     int & >0
	secretStore: #SecretStore
}

#GithubConnectionStep: {
	id:      "github-app"
	outcome: "created" | "unchanged" | "would-create"
	detail:  string
}

#GithubAppCredentialRefs: {
	store: #SecretStore
	// References name where a value lives (infisical:// or op://); five of
	// them, one per credential.
	references: [...=~"^(infisical|op)://"] & [_, _, _, _, _]
}

// CUE constraints for every protobuf type in data-models/hobo_cd.proto.
package hobo_cd

#SecretStore: "infisical" | "1password"

#VercelConnectionConfig: {
	integrationSlug: =~"^[a-z0-9-]{1,64}$"
	clientId:        =~"^oac_[A-Za-z0-9]+$"
	redirectUri:     =~"^http://127\\.0\\.0\\.1:[0-9]{2,5}/"
	secretStore:     #SecretStore
}

#VercelConnectionStep: {
	id:      "vercel"
	outcome: "created" | "unchanged" | "would-create"
	detail:  string
}

#VercelJunctionRecord: {
	junction: =~"^[a-z0-9-]+$"
	// At least the CD Yard and the Vercel Yard.
	yards: [string, string, ...string]
	store: #SecretStore
}

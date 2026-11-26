package hobo

#FluxSourceKind: "oci" | "git"
#FluxTier: "community-free" | "paid-multi-instance"

#FluxDeploySpec: {
	source:                     #FluxSourceKind
	image_digest?:              string
	git_repository?:            string
	webhook_secret_ref?:        string
	api_key_secret_ref?:        string
	webhook_signed:             bool
	status_logs_authenticated:  bool
	tier:                       #FluxTier
	environment:                "preview" | "production"
}

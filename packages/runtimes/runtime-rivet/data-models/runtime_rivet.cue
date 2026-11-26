package hobo

#RivetRuntimeMode: "local" | "runner" | "serverless" | "managed"

#RivetInboxStatus:
	"persisted" | "processing" | "committed" | "completed" |
	"failed-retryable" | "failed-terminal"

#RivetRuntimeConfig: {
	camp_id:                string & !=""
	tenant_id:              string & !=""
	mode:                   #RivetRuntimeMode
	engine_image_digest?:   string
	endpoint_secret_ref?:   string
	admin_token_secret_ref?: string
	svid_binding_ref:       string & !=""
}

#RivetActorBinding: {
	tenant_id:      string & !=""
	project_id:     string & !=""
	actor_type_id:  string & !=""
	key_segments:   [...string]
	schema_version: int & >=1
	binding_epoch:  int & >=0
}

#RivetDoctorReport: {
	mode:               string & !=""
	rivetkit_available: bool
	journal_ready:      bool
	fidelity:           "local-sqlite" | "rivetkit" | "unsupported"
	notes:              [...string]
	remediation:        [...string]
}

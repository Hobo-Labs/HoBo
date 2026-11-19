package hobo


#DaprDeployMode: "self-hosted" | "kubernetes"

#DaprRuntimeConfig: {
	camp_id:             string & !=""
	tenant_id:           string & !=""
	app_id:              string & !=""
	mode:                #DaprDeployMode
	http_endpoint:       string
	grpc_endpoint?:      string
	placement_address?:  string
	actors_enabled:      bool
	pubsub_enabled:      bool
	workflow_enabled:    bool
	default_pubsub_name: string & !=""
	svid_binding_ref:    string & !=""
}

#DaprComponentSpec: {
	name:     string & !=""
	type:     string & !=""
	version:  string & !=""
	metadata: {[string]: string}
	scopes:   [...string]
}

#DaprComponentYaml: {
	api_version: "dapr.io/v1alpha1"
	kind:        "Component"
	name:        string & !=""
	body:        string
	secretless:  true
}

#DaprDoctorReport: {
	dapr_cli_available: bool
	runtime_reachable:  bool
	fidelity:           "simulated" | "live"
	notes:              [...string]
	remediation:        [...string]
}

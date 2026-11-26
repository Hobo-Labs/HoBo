package broker

// CUE constraints for yard_placement.proto wire forms.

#YardShape: {
	provider_id?: string
	runtime_id?:  string
	regions: [...string]
	require: [...string]
	prefer: [...string]
	labels?: {[string]: string}
}

#YardPlacementRequest: {
	request_id:                 string & !=""
	selection_mode:             string & !=""
	requested_yard_id?:         string
	requested_shape:            #YardShape
	bindle_manifest_hash:       string & !=""
	bindle_requirements_hash:   string & !=""
	allow_generation_requested: bool
}

#YardInstanceRegistration: {
	schema_version:   string & !=""
	yard_id:          string & !=""
	owner_tenant_id:  string & !=""
	provider_id:      string & !=""
	runtime_id:       string & !=""
	status:           string & !=""
	registration_seq: uint
}

#YardInventorySnapshot: {
	schema_version: string & !=""
	broker_id:      string & !=""
	seq:            uint
	content_hash:   string & !=""
	yards: [...#YardInstanceRegistration]
}

#YardRuntimeRegistration: {
	schema_version:         string & !=""
	runtime_id:             string & !=""
	provider_id:            string & !=""
	version:                string & !=""
	generator_connector_id: string & !=""
	status:                 string & !=""
	priority:               int
	is_default:             bool
}

#BindleDeploymentRequest: {
	schema_version:     string & !=""
	request_id:         string & !=""
	bindle_name:        string & !=""
	manifest_hash:      string & !=""
	yard:               #YardPlacementRequest
	objective:          string & !=""
	spend_estimate_usd: number
	owner_tenant_id:    string & !=""
}

#YardPlacementReceipt: {
	schema_version:       string & !=""
	request_id:           string & !=""
	broker_id:            string & !=""
	selected_yard_id:     string & !=""
	selected_provider_id: string & !=""
	selected_camp_id:     string & !=""
	inventory_hash:       string & !=""
	content_hash:         string & !=""
}

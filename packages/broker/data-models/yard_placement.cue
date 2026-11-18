package broker

// CUE constraints for yard_placement.proto wire forms.

#YardJsonValue: null | bool | number | string | [...#YardJsonValue] | {[string]: #YardJsonValue}

// ECMAScript String.trim whitespace: preserve nonblank input without normalizing it.
#PlacementNonblank: string & !~"^[\\x{0009}-\\x{000D}\\x{0020}\\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]*$"
#CampNonblank:      #PlacementNonblank
#YardIdNonblank:    #PlacementNonblank

#PlacementLabelEntry: {
	key:   string
	value: string
}

#CampPlacementLayout: {
	id?:       string
	env?:      string
	env_type?: #CampNonblank & !~"/"
	require?: [...#CampNonblank]
	prefer?: [...#CampNonblank]
	labels?: {[string]: string}
	runtime_requirements?: [...#CampNonblank]
	canonical_labels?: [...#PlacementLabelEntry]
}

#YardShape: {
	provider_id?: string
	runtime_id?:  string
	regions: [...string]
	require: [...string]
	prefer: [...string]
	labels?: {[string]: string}
	residency?: [...string]
	isolation?: [...string]
	network?: [...string]
	component_hosts?: [...string]
	properties?: {[string]: #YardJsonValue}
	camps?: [...#CampPlacementLayout]
	canonical_labels?: [...#PlacementLabelEntry]
	properties_json?: string
}

#YardPlacementRequest: {
	request_id:                 string & !=""
	selection_mode:             "exact" | "compatible" | "compatible-or-generate"
	requested_yard_id?:         #YardIdNonblank
	requested_shape:            #YardShape
	bindle_manifest_hash:       string & !=""
	bindle_requirements_hash:   string & !=""
	allow_generation_requested: bool
	if selection_mode == "exact" {
		requested_yard_id!: #YardIdNonblank
	}
}

#BindleRequirements: {
	require?: [...string]
	prefer?: [...string]
	runtimes?: [...string]
	labels?: {[string]: string}
	canonical_labels?: [...#PlacementLabelEntry]
}

#YardResourceRequest: {
	resource_id: string & !=""
	port:        string & !=""
	features?: [...string & !=""]
	region?: string & !=""
}

#CampPlacementInput: {
	selection_mode: "exact" | "compatible" | "compatible-or-generate"
	camp_id?:       #CampNonblank
	layout:         #CampPlacementLayout
	if selection_mode == "exact" {
		camp_id!: #CampNonblank
	}
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
	schema_version:      string & !=""
	request_id:          string & !=""
	bindle_name:         string & !=""
	manifest_hash:       string & !=""
	yard:                #YardPlacementRequest
	objective:           string & !=""
	spend_estimate_usd:  number & >=0
	owner_tenant_id:     string & !=""
	bindle_requirements: #BindleRequirements
	resources?: [...#YardResourceRequest]
	camp?:                 #CampPlacementInput
	work_binding_version!: 1 | 2
	request_digest:        string & =~"^sha256:[0-9a-f]{64}$"
	if work_binding_version == 2 {
		yard: requested_shape: properties_json!: string
	}
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

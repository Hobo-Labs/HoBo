package replay

#PrivacyPolicy: {
	schema_version:  string & !=""
	mask_inputs:     bool
	mask_passwords:  bool
	mask_emails:     bool
	mask_tel:        bool
	mask_selectors:  [...string]
	block_attributes: [...string]
	capture_network: bool
	capture_console: bool
	capture_errors:  bool
}

#SessionCorrelation: {
	schema_version:          string & !=""
	principal_ref?:          string
	station_id:              string & !=""
	yard_id?:                string
	camp_id?:                string
	trail_id?:               string
	control_plane_event_id?: string
	error_id?:               string
	harness_flag_keys:       [...string]
	isolation_class:         "local-dev" | "preview" | "development" | "staging" | "production" | "ephemeral"
	tenant:                  string & !=""
	env:                     string & !=""
}

#RecordingChunk: {
	schema_version: string & !=""
	session_id:     string & !=""
	seq:            uint
	content_hash:   =~"^sha256:[a-f0-9]{64}$"
	byte_size:      uint
	blob_ref:       string & !=""
	created_at:     string & !=""
}

#SessionRecord: {
	schema_version: string & !=""
	id:             string & !=""
	status:         "recording" | "ended" | "retained" | "erased"
	started_at:     string & !=""
	ended_at?:      string
	correlation:    #SessionCorrelation
	privacy:        #PrivacyPolicy
	chunk_count:    uint
	total_bytes:    uint
	summary?:       string
}

#ReplayLifecycleEventData: {
	session_id:     string & !=""
	event_type:     string & =~"^replay\\."
	station_id:     string & !=""
	correlation_id: string & !=""
	blob_ref?:      string
	error_id?:      string
	bytes?:         uint
}

package management

// CUE constraints for every protobuf message in management.proto.

#ManagementEnvelope: {
	ok:      bool
	code:    string
	message: string
	status?: string
}

#StationOccupancyView: {
	station_id:           string
	status:               "open" | "closed"
	active_rail_hash?:    string
	bootstrap_rail_hash?: string
	bootstrap_active:     bool
	connection_count:     uint
	seq:                  uint
}

#RailView: {
	id:                string
	name:              string
	content_hash:      string
	activation_status: "draft" | "approved" | "active" | "retired"
	is_bootstrap:      bool
	quota_used:        number & >=0
	quota_limit:       number & >=0
	spend_cap_usd:     number & >=0
}

#ConnectionPublicView: {
	id:         string
	alias?:     string
	provider:   string
	flow?:      string
	status:     string
	station_id: string
	tenant:     string
}

#MeteringView: {
	quota_used:    number & >=0
	quota_limit:   number & >=0
	spend_cap_usd: number & >=0
	budget_usd:    number & >=0
	traffic_rate:  number & >=0
	// Provenance badge (HIGHBALL "kill or badge"): synthetic until real
	// metering signals flow.
	traffic_rate_source?: "synthetic" | "otlp"
}

#ConnectorActivityView: {
	connector_kind: string
	status:         "offline" | "idle" | "working" | "error"
	connection_id?: string
	// Provenance badge: statically derived until live agent telemetry flows.
	status_source?: "derived-static" | "otlp"
}

// Envelope only: DeploymentView row shapes are owned by package cloud
// (packages/cloud/data-models/cloud.cue) — referenced, not duplicated.
#DeploymentViewProjectionView: {
	available: bool
	source:    "yard-eventstore" | "none"
	yards: [...string]
	count:             uint
	seq:               uint
	json_deployments?: string
}

// Envelope only: CredentialAuditRecord shapes are owned by package cloud
// (packages/cloud/data-models/cloud.cue) — referenced, not duplicated.
#CredentialAuditProjectionView: {
	available: bool
	sources: [...("connections-store" | "yard-eventstore")]
	count:      uint
	seq:        uint
	json_rows?: string
}

#DoctorView: {
	bootstrap_active: bool
	hazards: [...string]
	hint?: string
}

#YardProjectionSnapshot: {
	occupancy:   #StationOccupancyView
	rails: [...#RailView]
	connections: [...#ConnectionPublicView]
	metering:    #MeteringView
	activity: [...#ConnectorActivityView]
	doctor:      #DoctorView
	seq:         uint
}

package connectivity

// CUE constraints for connectivity wire forms (see connectivity.proto).

#UsageEventRecord: {
	tenant_id:  string & !=""
	event_type: string & !=""
	resource:   string & !=""
	quantity:   number
	unit:       string & !=""
	timestamp:  string & !=""
}

#NamedEndpointRecord: {
	tenant_id:   string & !=""
	resource:    string & !=""
	hostname:    string & !=""
	url:         string & !=""
	mode:        "local" | "overlay"
	backend_url: string
}

#PublicDnsEntrypointRecord: {
	tenant_id:         string & !=""
	hostname:          string & !=""
	gateway_hostname:  string & !=""
	managed_by:        "hobo" | "cloud-provider" | "none"
	provider:          string & !=""
}

// ADR-0027 secretless connector public lease (credential never on the wire).
#SecretlessLeaseRecord: {
	lease_id:       string & !=""
	protocol:       string & !=""
	local_endpoint: string & !=""
	target_ref:     string & !=""
	expires_at:     string & !=""
	has_credential: true
	isolation:      "shared" | "per-tenant" | "per-workload"
	tenant_id?:     string
	workload_id?:   string
}

#EnvMembershipRecord: {
  id: string & != ""
  principalId: string & != ""
  isolationClass: "local-dev" | "preview" | "development" | "staging" | "production" | "ephemeral"
  assignedAt: string & != ""
  assignedBy: string & != ""
  expiresAt?: string
  dualControlRequired: bool
  controlPlaneGated: true
}

#ElevatedAccessCapabilityRecord: {
  id: string & != ""
  subject: string & != ""
  audience: string & != ""
  isolationClass: "local-dev" | "preview" | "development" | "staging" | "production" | "ephemeral"
  issuedAt: string & != ""
  expiresAt: string & != ""
  tokenRef: =~"^tokenref://"
}

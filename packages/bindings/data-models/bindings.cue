// Binding + secret-locator invariants.
//
// The load-bearing rule here is that credential_ref and certificate_ref are
// URI locators in a registered scheme. Anything that looks like a value —
// userinfo, a connection string, a bearer token — is rejected at the parse
// boundary, which is why these patterns are constraints and not documentation.

package bindings

#SecretRefScheme: "vault" | "azure-kv" | "aws-sm" | "gcp-sm" | "op" | "infisical" | "hobo-secret" | "hobo-token"

// scheme://authority/path with no userinfo (no "@" before the first "/").
#SecretRef: =~"^(vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token)://[^@\\s]+$"

#BindingProtocol: "postgresql" | "redis" | "https" | "wss" | "s3" | "amqp" | "nats" | "mqtt"

#BindingProfileId: =~"^binding\\.[a-z0-9-]+(\\.[a-z0-9-]+)*/v[0-9]+$"

#NonSecretEndpointRefRecord: {
	host:    string & !=""
	port?:   uint & >0 & <=65535
	path?:   string
	region?: string
	// A host is a host. A connection string is not.
	_noCredentials: true & (host !~ "://")
}

#BindingEndpointRecord: {
	protocol:    #BindingProtocol
	address_ref: #NonSecretEndpointRefRecord
	role?:       "primary" | "replica" | "pooler" | "admin"
}

#CapabilityBindingRecord: {
	schema_version:         "hobo.capability-binding/v1"
	id:                     string & !=""
	resource_ref:           string & !=""
	capability_profile_ref: string & !=""
	binding_profile_ref:    #BindingProfileId
	type:                   string & !=""
	provider?:              string
	endpoints:              [...#BindingEndpointRecord]
	credential_ref?:        #SecretRef
	certificate_ref?:       #SecretRef
	metadata_refs?: [string]: string
	expires_at?:            =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
	renewable:              bool
	rotation_supported:     bool
	revocation_supported:   bool
	producer_evidence_ref:  string & !=""
	// An expiring binding that cannot be renewed or rotated strands the
	// workload at expiry, so the catalog refuses to describe one.
	_expiryIsRecoverable: true & (expires_at == _|_ | renewable | rotation_supported)
}

#ConnectivityImplementationRecord: {
	id:                  =~"^[a-z0-9-]+(\\.[a-z0-9-]+)*/v[0-9]+$"
	binding_profile_ref: #BindingProfileId
	runtime_model:       "wasm" | "oci" | "vm_iaas" | "paas" | "serverless_faas"
	provider_id?:        string
	description:         string
}

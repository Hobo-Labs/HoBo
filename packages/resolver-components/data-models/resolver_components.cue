// CUE constraints for every protobuf type in resolver_components.proto
// (plan 0024 WP8). Bounds mirror CD_DEFAULTS in @hobo/cd: 128 MiB memory,
// 30 s per call, 10^9 fuel, at most 32 allowlisted hosts.

package data_models

import "list"

#Digest: string & =~"^sha256:[0-9a-f]{64}$"
#Host:   string & =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"

#EgressHostRecord: {
	host: #Host
	ports: [...string & =~"^[0-9]{1,5}$"]
	path_prefixes: [...string & =~"^/"]
	local_addresses: [...string & !=""]
}

#CredentialBindingRecord: {
	hosts: [...#Host]
}

#ComponentLimitsRecord: {
	memory_bytes:    int & >0 & <=134217728
	call_timeout_ms: int & >0 & <=30000
	fuel:            int & >0 & <=1000000000
}

#ResourceClassRecord: {
	product_id: string & =~"^[a-z0-9][a-z0-9._/-]{0,127}$"
	slot:       string & !=""
	retained_fields: [...string & !=""]
	observe_fields: [...string & !=""]
	directives: [...string & =~"^[A-Za-z][A-Za-z0-9_]{0,63}$"]
}

#ReconcilerModeRecord: "RECONCILER_MODE_RECORD_UNSPECIFIED" | "RECONCILER_MODE_RECORD_CONDUCTOR" | "RECONCILER_MODE_RECORD_AGENT"

#ResolverComponentManifestRecord: {
	schema:      "hobo.resolver-components.manifest/v1"
	id:          string & =~"^[a-z0-9][a-z0-9._-]{0,63}$"
	version:     string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+"
	world:       "hobo:resolver/resolver-component@0.1.0"
	wasm_digest: #Digest
	provider_id: string & =~"^[a-z0-9][a-z0-9._/-]{0,127}$"
	classes: [_, ...#ResourceClassRecord]
	egress: [...#EgressHostRecord] & list.MaxItems(32)
	credential: #CredentialBindingRecord
	limits:     #ComponentLimitsRecord
	modes: [_, ...#ReconcilerModeRecord]
}

#ResolverDescriptionRecord: {
	component_id: string & !=""
	version:      string & !=""
	classes: [_, ...#ResourceClassRecord]
}

#EgressDenialCode: "EGRESS_DENIAL_CODE_UNSPECIFIED" | "EGRESS_DENIAL_CODE_HOST_NOT_ALLOWLISTED" | "EGRESS_DENIAL_CODE_SCHEME_FORBIDDEN" | "EGRESS_DENIAL_CODE_PORT_FORBIDDEN" | "EGRESS_DENIAL_CODE_PATH_FORBIDDEN" | "EGRESS_DENIAL_CODE_METADATA_ENDPOINT" | "EGRESS_DENIAL_CODE_PRIVATE_ADDRESS" | "EGRESS_DENIAL_CODE_REBINDING" | "EGRESS_DENIAL_CODE_REDIRECT" | "EGRESS_DENIAL_CODE_CREDENTIAL_SCOPE" | "EGRESS_DENIAL_CODE_SECRET_EXFILTRATION" | "EGRESS_DENIAL_CODE_BODY_TOO_LARGE"

#EgressDenialRecord: {
	code:   #EgressDenialCode & !="EGRESS_DENIAL_CODE_UNSPECIFIED"
	host:   string
	detail: string & !=""
}

#InvocationOutcome: "INVOCATION_OUTCOME_UNSPECIFIED" | "INVOCATION_OUTCOME_OK" | "INVOCATION_OUTCOME_GUEST_ERROR" | "INVOCATION_OUTCOME_EGRESS_DENIED" | "INVOCATION_OUTCOME_SECRET_EXFILTRATION" | "INVOCATION_OUTCOME_FUEL_EXHAUSTED" | "INVOCATION_OUTCOME_MEMORY_EXCEEDED" | "INVOCATION_OUTCOME_TIMEOUT" | "INVOCATION_OUTCOME_TRAP" | "INVOCATION_OUTCOME_OUTPUT_UNPARSEABLE"

#ComponentInvocationRecord: {
	component_id:      string & !=""
	wasm_digest:       #Digest
	product_id:        string
	operation:         "describe" | "reconcile" | "read" | "delete" | "instances"
	outcome:           #InvocationOutcome & !="INVOCATION_OUTCOME_UNSPECIFIED"
	fuel_used:         int & >=0 & <=1000000000
	peak_memory_bytes: int & >=0
	duration_ms:       int & >=0
	egress_calls:      int & >=0
	denials: [...#EgressDenialRecord]
}

#ConformanceCheckRecord: {
	id:     string & =~"^[a-z0-9][a-z0-9.-]*$"
	passed: bool
	detail: string
}

#ConformanceReportRecord: {
	component_id: string & !=""
	version:      string & !=""
	wasm_digest:  #Digest
	passed:       bool
	checks: [_, ...#ConformanceCheckRecord]
}

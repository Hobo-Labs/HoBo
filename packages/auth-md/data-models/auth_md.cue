package authmd

// CUE constraints for the auth.md wire forms (see auth_md.proto).
// These constraints are what the parse-don't-validate constructors in
// src/ enforce at the one parser boundary: nothing downstream re-checks.

#Iso8601: string & =~"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$"

// HTTPS-only: discovery never follows an http:// resource.
#HttpsUrl: string & =~"^https://[^\\s]+$"

// Opaque locator for key/assertion/token material. The scheme is deliberately
// not a URL a caller can dereference without the broker.
#MaterialLocator: string & =~"^authmd-secret://[a-z0-9-]+/[A-Za-z0-9._-]+$"

#Scope: string & =~"^[A-Za-z0-9:._-]+$"

#AgentPrincipalPhaseRecord: "unregistered" | "pre-claim" | "human-bound" | "revoked"

#HumanSessionPhaseRecord: "anonymous" | "authenticated"

#InfrastructurePhaseRecord: "temporary" | "owner-controlled" | "expired"

#ProtectedResourceMetadataRecord: {
	resource: #HttpsUrl
	authorization_servers: [...#HttpsUrl]
	scopes_supported: [...#Scope]
	bearer_methods_supported: [...string]
	anonymous_registration_endpoint?: #HttpsUrl
	auth_md_url?:                     #HttpsUrl
}

#AuthMdDocumentRecord: {
	url: #HttpsUrl
	declared_scopes: [...#Scope]
	declares_anonymous_registration: bool
	sha256:                          string & =~"^[a-f0-9]{64}$"
}

#MetadataProseConflictRecord: {
	field:          string & !=""
	metadata_value: string
	document_value: string
	// Structured metadata is machine-authoritative; prose never wins.
	authority: "metadata"
}

#SessionBindingRecord: {
	session_id: string & !=""
	tenant_id:  string & !=""
	project_id: string & !=""
	audience:   string & !=""
	service:    #HttpsUrl
}

#AgentRegistrationRecord: {
	registration_ref: string & !=""
	pre_claim_scopes: [...#Scope]
	key_material_locator: #MaterialLocator
	binding:              #SessionBindingRecord
	issued_at:            #Iso8601
	expires_at?:          #Iso8601
	phase:                "pre-claim" | "human-bound" | "revoked"
	rotation_endpoint?:   #HttpsUrl
	revocation_endpoint?: #HttpsUrl
}

#AgentPrincipalClaimRefRecord: {
	protocol:         "auth.md" | "custom"
	registration_ref: string & !=""
	pre_claim_scopes: [...#Scope]
	post_claim_scopes: [...#Scope]
	rotate_after_infrastructure_claim: bool
}

#IdentityAssertionRecord: {
	registration_ref: string & !=""
	subject:          string & !=""
	issuer:           #HttpsUrl
	audience:         string & !=""
	scopes: [...#Scope]
	issued_at:         #Iso8601
	expires_at:        #Iso8601
	assertion_locator: #MaterialLocator
}

#KeyRotationRecord: {
	registration_ref:     string & !=""
	previous_key_locator: #MaterialLocator
	current_key_locator:  #MaterialLocator
	rotated_at:           #Iso8601
	reason:               "infrastructure-claim" | "revocation" | "operator"
}

#AgentPrincipalEventRecord: {
	type:             string & =~"^authmd\\.[A-Za-z]+$"
	registration_ref: string & !=""
	occurred_at:      #Iso8601
	phase:            #AgentPrincipalPhaseRecord
	scopes: [...#Scope]
	detail?: string
}

#AgentAccessTokenRecord: {
	registration_ref:     string & !=""
	access_token_locator: #MaterialLocator
	token_type:           "Bearer"
	scopes: [...#Scope]
	binding:    #SessionBindingRecord
	issued_at:  #Iso8601
	expires_at: #Iso8601
	issuer:     #HttpsUrl
}

#ClaimedAgentPrincipalRecord: {
	registration_ref: string & !=""
	phase:            "human-bound"
	human_subject:    string & !=""
	binding:          #SessionBindingRecord
	pre_claim_scopes: [...#Scope]
	post_claim_scopes: [...#Scope]
	claimed_at:                        #Iso8601
	rotate_after_infrastructure_claim: bool
	rotation_satisfied:                bool
}

#ClaimInitiationRecord: {
	registration_ref: string & !=""
	claim_url:        #HttpsUrl
	poll_endpoint:    #HttpsUrl
	expires_at:       #Iso8601
	interval_seconds: number & >=0
	requested_post_claim_scopes: [...#Scope]
	poll_token_locator: #MaterialLocator
}

#RevokedAgentPrincipalRecord: {revoked_at: #Iso8601}

#CliAuthMdStateRecord: {
	let ref = registration_ref
	let session = binding
	let scopes = pre_claim_scopes
	schema_version:   "hobo.cli-authmd/v1"
	resource:         #HttpsUrl
	registration_ref: string & !=""
	binding:          #SessionBindingRecord
	pre_claim_scopes: [...#Scope]
	key_material_locator: #MaterialLocator
	issued_at:            #Iso8601
	expires_at?:          #Iso8601
	claim_endpoint?:      #HttpsUrl
	rotation_endpoint?:   #HttpsUrl
	revocation_endpoint?: #HttpsUrl
	revoked?:             #RevokedAgentPrincipalRecord
	deployments?: [...string & !=""]
	owned_deployments?: [...string & !=""]
	initiation?: #ClaimInitiationRecord & {registration_ref: ref}
	principal?: #ClaimedAgentPrincipalRecord & {registration_ref: ref, binding: session, pre_claim_scopes: scopes}
}

// Owner-only local custody boundary, NEVER a public wire/event shape.
#StoredCliAuthMdClaimInitiationRecord: {
	registration_ref: string & !=""
	claim_url:        #HttpsUrl
	poll_endpoint:    #HttpsUrl
	expires_at:       #Iso8601
	interval_seconds: number & >=0
	requested_post_claim_scopes: [...#Scope]
	poll_material: string & !=""
}

#StoredCliAuthMdStateRecord: {
	let ref = registration_ref
	let session = binding
	let scopes = pre_claim_scopes
	schema_version:   "hobo.cli-authmd/v1"
	resource:         #HttpsUrl
	registration_ref: string & !=""
	binding:          #SessionBindingRecord
	pre_claim_scopes: [...#Scope]
	private_key:          string
	issued_at:            #Iso8601
	expires_at?:          #Iso8601
	claim_endpoint?:      #HttpsUrl
	rotation_endpoint?:   #HttpsUrl
	revocation_endpoint?: #HttpsUrl
	revoked?:             #RevokedAgentPrincipalRecord
	deployments?: [...string & !=""]
	owned_deployments?: [...string & !=""]
	initiation?: #StoredCliAuthMdClaimInitiationRecord & {registration_ref: ref}
	principal?: #ClaimedAgentPrincipalRecord & {registration_ref: ref, binding: session, pre_claim_scopes: scopes}
}

package authmdcli

// The CLI stores protobuf-JSON camelCase names. Public and private custody
// records are separate closed boundaries; material cannot be added publicly.
#Instant: string & =~"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$"
#Https:   string & =~"^https://[^\\s]+$"
#Ref:     string & !=""
#Scope:   string & =~"^[A-Za-z0-9:._-]+$"
#Locator: string & =~"^authmd-secret://[a-z0-9-]+/[A-Za-z0-9._-]+$"
#Binding: {
	sessionId: #Ref
	tenantId:  #Ref
	projectId: #Ref
	audience:  #Ref
	service:   #Https
}
#ClaimedAgentPrincipalRecord: {
	registrationRef: #Ref
	phase:           "human-bound"
	humanSubject:    #Ref
	binding:         #Binding
	preClaimScopes: [...#Scope]
	postClaimScopes: [...#Scope]
	claimedAt:                      #Instant
	rotateAfterInfrastructureClaim: bool
	rotationSatisfied:              bool
}
#ClaimInitiationRecord: {
	registrationRef: #Ref
	claimUrl:        #Https
	pollEndpoint:    #Https
	expiresAt:       #Instant
	intervalSeconds: number & >=0
	requestedPostClaimScopes: [...#Scope]
	pollTokenLocator: #Locator
}
#StoredCliAuthMdClaimInitiationRecord: {
	registrationRef: #Ref
	claimUrl:        #Https
	pollEndpoint:    #Https
	expiresAt:       #Instant
	intervalSeconds: number & >=0
	requestedPostClaimScopes: [...#Scope]
	pollMaterial: #Ref
}
#Revoked: {revokedAt: #Instant}
#CliAuthMdStateRecord: {
	let ref = registrationRef
	let session = binding
	let scopes = preClaimScopes
	schemaVersion:   "hobo.cli-authmd/v1"
	resource:        #Https
	registrationRef: #Ref
	binding:         #Binding
	preClaimScopes: [...#Scope]
	keyMaterialLocator:  #Locator
	issuedAt:            #Instant
	expiresAt?:          #Instant
	claimEndpoint?:      #Https
	rotationEndpoint?:   #Https
	revocationEndpoint?: #Https
	revoked?:            #Revoked
	deployments?: [...#Ref]
	ownedDeployments?: [...#Ref]
	initiation?: #ClaimInitiationRecord & {registrationRef: ref}
	principal?: #ClaimedAgentPrincipalRecord & {registrationRef: ref, binding: session, preClaimScopes: scopes}
}

// This shape is ONLY accepted for the owner-only private custody file.
#StoredCliAuthMdStateRecord: {
	let ref = registrationRef
	let session = binding
	let scopes = preClaimScopes
	schemaVersion:   "hobo.cli-authmd/v1"
	resource:        #Https
	registrationRef: #Ref
	binding:         #Binding
	preClaimScopes: [...#Scope]
	privateKey:          string
	issuedAt:            #Instant
	expiresAt?:          #Instant
	claimEndpoint?:      #Https
	rotationEndpoint?:   #Https
	revocationEndpoint?: #Https
	revoked?:            #Revoked
	deployments?: [...#Ref]
	ownedDeployments?: [...#Ref]
	initiation?: #StoredCliAuthMdClaimInitiationRecord & {registrationRef: ref}
	principal?: #ClaimedAgentPrincipalRecord & {registrationRef: ref, binding: session, preClaimScopes: scopes}
}

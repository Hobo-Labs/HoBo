package hobo

#HostingCredentialScopeRequest: {
	tenantId: string & !=""
	providerId: string & !=""
	providerAccountId: string & !=""
	credentialRef: =~"^[a-z][a-z0-9+.-]*://[^ @\\t\\r\\n]+$"
	operationId: string & !=""
	nowMs: int & >=0 & <=9007199254740991
}

#HostingCredentialScopeBinding: {
	tenantId: string & !=""
	providerId: string & !=""
	providerAccountId: string & !=""
	credentialRef: =~"^[a-z][a-z0-9+.-]*://[^ @\\t\\r\\n]+$"
	credentialVersion: string & !=""
	nativeAccountRef: string & !=""
	evidenceRef: =~"^[a-z][a-z0-9+.-]*:[^ \\t\\r\\n]+$"
	observedAtMs: int & >=0 & <=9007199254740991
	validUntilMs: int & >observedAtMs & <=9007199254740991
	credentialDigest: =~"^sha256:[a-f0-9]{64}$"
}

#HostingCredentialScopeChallenge: {
	request: #HostingCredentialScopeRequest
	challengeId: string & !=""
}

#HostingCredentialScopeClaims: {
	schemaVersion: "hobo.hosting-credential-scope/v1"
	attestationId: string & !=""
	issuerId: string & !=""
	keyId: string & !=""
	binding: #HostingCredentialScopeBinding
	operationId: string & !=""
	challengeId: string & !=""
	issuedAtMs: int & >=binding.observedAtMs & <=9007199254740991
	expiresAtMs: int & >issuedAtMs & <=binding.validUntilMs & <=9007199254740991
}

#HostingCredentialScopeAttestation: {
	claims: #HostingCredentialScopeClaims
	signature: =~"^ed25519:[A-Za-z0-9_-]{86}$"
}

#HostingCredentialScopeUse: {
	issuerId: string & !=""
	keyId: string & !=""
	attestationId: string & !=""
	operationId: string & !=""
	proofDigest: =~"^sha256:[a-f0-9]{64}$"
	consumedAtMs: int & >=0 & <=9007199254740991
	expiresAtMs: int & >consumedAtMs & <=9007199254740991
}

HostingCredentialScopeRequest: #HostingCredentialScopeRequest
HostingCredentialScopeBinding: #HostingCredentialScopeBinding
HostingCredentialScopeChallenge: #HostingCredentialScopeChallenge
HostingCredentialScopeClaims: #HostingCredentialScopeClaims
HostingCredentialScopeAttestation: #HostingCredentialScopeAttestation
HostingCredentialScopeUse: #HostingCredentialScopeUse

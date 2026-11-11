package adapter_infisical

// Constraints for the Infisical config-service boundary (ADR-0179). Field
// names are the protobuf JSON names, which are also Infisical's wire names.

#jwt: string & =~"^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$"

#InfisicalBinding: {
	// HTTPS, or plain HTTP to a loopback address (a local Infisical or a test).
	siteUrl:     string & (=~"^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$" | =~"^http://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:[0-9]{1,5})?$")
	projectId:   string & =~"^[A-Za-z0-9-]{1,64}$"
	environment: string & =~"^[a-z0-9][a-z0-9_-]{0,63}$"
	secretPath:  string & =~"^/([A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*)?$" & =~"^.{1,512}$"
}

#InfisicalLoginResponse: {
	accessToken:        string & =~"^[!-~]+$"
	expiresIn:          int & >0 & <=31536000
	accessTokenMaxTTL?: int & >=0
	tokenType:          "Bearer"
	...
}

#InfisicalSecret: {
	secretKey: string & =~"^[A-Za-z0-9_.-]{1,256}$"
	secretValue: string
	version:     int & >=1
	// A read needs false; a names-only listing (viewSecretValue=false) is true.
	secretValueHidden?: bool
	...
}

#InfisicalSecretList: {
	secrets: [...#InfisicalSecret]
	...
}

#InfisicalApproval: {
	id: string & !=""
	...
}

// A write held by a secret-protection policy answers `approval`, not `secret`.
#InfisicalSecretEnvelope: {
	secret: #InfisicalSecret
	...
} | {
	approval: #InfisicalApproval
	...
}

#InfisicalErrorEnvelope: {
	reqId?:      string
	statusCode?: int & >=400 & <=599
	error?:      string
	...
}

#InfisicalOidcLoginRequest: {
	identityId: string & =~"^[A-Za-z0-9-]{1,64}$"
	jwt:        #jwt
}

#InfisicalUniversalAuthLoginRequest: {
	clientId:     string & =~"^[!-~]+$"
	clientSecret: string & =~"^[!-~]+$"
}

#InfisicalSecretWriteRequest: {
	projectId:   #InfisicalBinding.projectId
	environment: #InfisicalBinding.environment
	secretPath:  #InfisicalBinding.secretPath
	secretValue: string
	type:        "shared"
}

// The GitHub Actions OIDC token endpoint's answer.
#GithubActionsIdToken: {
	value: #jwt
	...
}

// The flat fixture corpus holds bindings.
#AdapterInfisical: #InfisicalBinding

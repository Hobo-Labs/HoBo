// CUE constraints for every protobuf type in data-models/fleet_authority.proto.
package data_models

import (
	"list"
)

#Https: string & =~"^https://[^\\s]+$"
#Principal: string & =~"^(user|agent|service|system):[^\\s]+$"
#SecretName: string & =~"^[A-Za-z0-9_./#-]{1,256}$"

#SignInProviderConfig: {
	id:                  "oidc" | "github" | "atproto"
	issuer?:             #Https
	clientId:            string & !=""
	clientSecretSecret?: #SecretName
	principalClaim?:     string & =~"^[A-Za-z0-9_]{1,64}$"
	scopes?: [...string & =~"^[A-Za-z0-9_:.-]{1,64}$"]
	webBase?: #Https
	apiBase?: #Https
}

#DirectoryEntryConfig: {
	principal: #Principal
	tags: [...string & =~"^[a-z0-9_.:-]{1,64}$"]
	aliases?: [...#Principal]
}

#ClaimRuleConfig: {
	issuer?: string
	claim:   string & =~"^[A-Za-z0-9_]{1,64}$"
	equals:  string & !=""
	tags: [...string & =~"^[a-z0-9_.:-]{1,64}$"] & list.MinItems(1)
}

#PinnedIssuerConfig: {
	issuer:   #Https
	jwksUri?: #Https
}

#AccountConfig: {
	principal: #Principal
	scopes: [...string & =~"^[a-z0-9_.:-]{1,64}$"]
	credentialSecret: #SecretName
}

#OverlayProviderConfig: {
	provider:         "tailscale" | "netbird"
	apiBase:          #Https
	organisation?:    string
	credentialSecret: #SecretName
}

#SecretStoreConfig: {
	kind:       "openbao"
	address:    #Https
	role:       string & !=""
	tokenFile:  string & =~"^/[^\\s]+$"
	mountPath?: string
	namespace?: string
}

#FleetAuthorityConfig: {
	issuer:  #Https
	profile: "standalone" | "high-availability"
	natsUrls: [...string & =~"^(tls|wss|nats)://[^\\s]+$"] & list.MinItems(1)
	relayUrls: [...#Https]
	minAgentVersion:                string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	tenant:                         string & =~"^[a-z0-9][a-z0-9-]{0,62}$"
	dataDir?:                       string
	secretPrefix?:                  #SecretName
	natsCredentialsSecret?:         #SecretName
	listen?:                        string & =~"^[^\\s]+:[0-9]{1,5}$"
	sessionKeySecret?:              #SecretName
	signIn?: [...#SignInProviderConfig]
	directory?: [...#DirectoryEntryConfig]
	claimRules?: [...#ClaimRuleConfig]
	oidcIssuers?: [...#PinnedIssuerConfig]
	accounts?: [...#AccountConfig]
	overlay?: [...#OverlayProviderConfig]
	natsSentinelCredentialsSecret?: #SecretName
	witnessNatsCredentialsSecret?:  #SecretName
	calloutXkeySecret?:             #SecretName
	secretStore?:                   #SecretStoreConfig
}

// Root definition for fixture vetting.
#FleetAuthority: #FleetAuthorityConfig

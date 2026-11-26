package data_models

import "list"

#Sha256Ref: string & =~"^sha256:[a-f0-9]{64}$"

#ManifestSignature: {
	alg:     "HOBO-FIXTURE-SHA256"
	key_id:  string & !=""
	digest:  #Sha256Ref
}

#ManifestIndex: {
	schema_version: "hobo.core/v1"
	issuer:         string & =~"^https://"
	manifest_digest: #Sha256Ref
	signature:      #ManifestSignature
	files: [...string] & list.MinItems(3)
}

#CapabilityPort: {
	port:      string & !=""
	kinds:     [...string] & list.MinItems(1)
	stability: #InterfaceStability
}

#CapabilitiesFile: {
	ports:                 [...#CapabilityPort]
	regions:               [...string] & list.MinItems(1)
	equivalence_classes:   [...string]
}

#AuthFlow: {
	type: string
}

#AuthAudit: {
	events: [...string] & list.MinItems(1)
}

#AuthFile: {
	issuer:              string & =~"^https://"
	flows:               [...#AuthFlow]
	scope_model:         "least-privilege-per-resource"
	resource_indicators: [...string] & list.MinItems(1)
	token_lifetime_sec:  int & >0 & <=86400
	audit:               #AuthAudit
}

#CostFile: {
	currency: string & =~"^[A-Z]{3}$"
}

#CapabilityManifestBundle: {
	index:        #ManifestIndex
	capabilities: #CapabilitiesFile
	auth:         #AuthFile
	cost:         #CostFile
}

#InterfaceStability: "stable" | "preview" | "experimental"

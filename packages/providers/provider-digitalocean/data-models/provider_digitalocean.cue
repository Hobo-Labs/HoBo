package hobo

// CUE constraints for the DigitalOcean CloudProvider wire records. One
// constraint per protobuf message in provider_digitalocean.proto.

#EquivalenceMapping: {
	class:           string & !=""
	port:            string & !=""
	resourceClass:   =~"^digitalocean:"
	providerService: string & !=""
	features: [...string] & !=[]
}

#CapabilityManifestIndex: {
	schema:         "hobo.capability-manifest-index/v1"
	providerId:     "@hobo/provider-digitalocean"
	manifestSchema: "hobo.capability-manifest/v1"
}

#CostFact: {
	pricingStatus?: "unknown" | "estimate" | "verified-zero"
	if pricingStatus != _|_ {if pricingStatus == "verified-zero" {marginalPrice: =~"^0\\.0+$"}}
	port:             string & !=""
	sku:              =~"^digitalocean\\."
	unit:             string & !=""
	marginalPrice:    =~"^[0-9]+\\.[0-9]+$"
	freeTierIncluded: uint
}

#AuthPosture: {
	schema:        "hobo.provider-auth/v1"
	mode:          "svid-federation"
	tokenAudience: =~"^spiffe://hobo/providers/"
	exchange:      "hobo:broker-credential-locator"
	staticSecrets: false
}

#RealizedIacResource: {
	name:     string & !=""
	type:     =~"^digitalocean:"
	provider: "digitalocean"
	outputs: [...string] & !=[]
}

#RealizedIacProgram: {
	apiVersion:   "hobo.iac-program/v1"
	kind:         "iac-program"
	provider:     "pulumi"
	deploymentId: string & !=""
	stack:        =~"^digitalocean/"
	resources: [...#RealizedIacResource] & !=[]
}

#YardBindingRow: {
	profile:         =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"
	productId?:      =~"^digitalocean\\.[a-z0-9-]+/v[1-9][0-9]*$"
	connectivityId?: string & !=""
}

#ResolvedResource: {
	productId:  =~"^digitalocean\\."
	action:     "create" | "update" | "adopt" | "noop" | "replace"
	physicalId: string & !=""
	diagnostics: [...string]
}

package hobo

// CUE constraints for the Hetzner CloudProvider wire records. One
// constraint per protobuf message in provider_hetzner.proto.

#EquivalenceMapping: {
	class:           string & !=""
	port:            string & !=""
	resourceClass:   =~"^hetzner:"
	providerService: string & !=""
	features: [...string] & !=[]
}

#CapabilityManifestIndex: {
	schema:         "hobo.capability-manifest-index/v1"
	providerId:     "@hobo/provider-hetzner"
	manifestSchema: "hobo.capability-manifest/v1"
}

#CostFact: {
	pricingStatus?: "unknown" | "estimate" | "verified-zero"
	if pricingStatus != _|_ {if pricingStatus == "verified-zero" {marginalPrice: =~"^0\\.0+$"}}
	port:             string & !=""
	sku:              =~"^hetzner\\."
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
	type:     =~"^hetzner:"
	provider: "hetzner"
	outputs: [...string] & !=[]
}

#RealizedIacProgram: {
	apiVersion:   "hobo.iac-program/v1"
	kind:         "iac-program"
	provider:     "pulumi"
	deploymentId: string & !=""
	stack:        =~"^hetzner/"
	resources: [...#RealizedIacResource] & !=[]
}

#YardBindingRow: {
	profile:         =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"
	productId?:      =~"^hetzner\\.[a-z0-9-]+/v[1-9][0-9]*$"
	connectivityId?: string & !=""
}

#ResolvedResource: {
	productId:  =~"^hetzner\\."
	action:     "create" | "update" | "adopt" | "noop" | "replace"
	physicalId: string & !=""
	diagnostics: [...string]
}

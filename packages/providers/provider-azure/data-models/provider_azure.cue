package hobo

// CUE constraints for the Azure CloudProvider wire records. One constraint per
// protobuf message in provider_azure.proto.

#EquivalenceMapping: {
	class:           string & !=""
	port:            string & !=""
	resourceClass:   =~"^azure:"
	providerService: string & !=""
	features: [...string] & !=[]
}

#CapabilityManifestIndex: {
	schema:         "hobo.capability-manifest-index/v1"
	providerId:     "@hobo/provider-azure"
	manifestSchema: "hobo.capability-manifest/v1"
}

#CostFact: {
	port:             string & !=""
	sku:              =~"^azure\\."
	unit:             string & !=""
	marginalPrice:    =~"^[0-9]+\\.[0-9]+$"
	freeTierIncluded: uint
}

#AuthPosture: {
	schema:        "hobo.provider-auth/v1"
	mode:          "svid-federation"
	tokenAudience: "api://AzureADTokenExchange"
	exchange:      "azuread:WorkloadIdentityFederation"
	staticSecrets: false
}

#RealizedIacResource: {
	name:     string & !=""
	type:     =~"^azure:"
	provider: "azure"
	outputs: [...string] & !=[]
}

#RealizedIacProgram: {
	apiVersion:   "hobo.iac-program/v1"
	kind:         "iac-program"
	provider:     "pulumi"
	deploymentId: string & !=""
	stack:        =~"^azure/"
	resources: [...#RealizedIacResource] & !=[]
}

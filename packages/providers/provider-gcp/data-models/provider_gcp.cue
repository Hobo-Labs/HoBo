package hobo

// CUE constraints for the GCP CloudProvider wire records. One constraint per
// protobuf message in provider_gcp.proto.

#EquivalenceMapping: {
	class:           string & !=""
	port:            string & !=""
	resourceClass:   =~"^gcp:"
	providerService: string & !=""
	features: [...string] & !=[]
}

#CapabilityManifestIndex: {
	schema:         "hobo.capability-manifest-index/v1"
	providerId:     "@hobo/provider-gcp"
	manifestSchema: "hobo.capability-manifest/v1"
}

#CostFact: {
	port:             string & !=""
	sku:              =~"^gcp\\."
	unit:             string & !=""
	marginalPrice:    =~"^[0-9]+\\.[0-9]+$"
	freeTierIncluded: uint
}

#AuthPosture: {
	schema:        "hobo.provider-auth/v1"
	mode:          "svid-federation"
	tokenAudience: =~"workloadIdentityPools"
	exchange:      "gcp:WorkloadIdentityFederation"
	staticSecrets: false
}

#RealizedIacResource: {
	name:     string & !=""
	type:     =~"^gcp:"
	provider: "gcp"
	outputs: [...string] & !=[]
}

#RealizedIacProgram: {
	apiVersion:   "hobo.iac-program/v1"
	kind:         "iac-program"
	provider:     "pulumi"
	deploymentId: string & !=""
	stack:        =~"^gcp/"
	resources: [...#RealizedIacResource] & !=[]
}

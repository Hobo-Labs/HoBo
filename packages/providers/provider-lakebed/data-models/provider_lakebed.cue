package hobo

// CUE constraints for the Lakebed deploy-target wire records. One constraint
// per protobuf message in provider_lakebed.proto.

#EquivalenceMapping: {
	class:           string & !=""
	port:            string & !=""
	resourceClass:   =~"^lakebed:"
	providerService: string & !=""
	features: [...string] & !=[]
}

#CapabilityManifestIndex: {
	schema:         "hobo.capability-manifest-index/v1"
	providerId:     "@hobo/provider-lakebed"
	manifestSchema: "hobo.capability-manifest/v1"
}

#CostFact: {
	port:             string & !=""
	sku:              =~"^lakebed\\."
	unit:             string & !=""
	marginalPrice:    =~"^[0-9]+\\.[0-9]+$"
	freeTierIncluded: uint
}

#AuthPosture: {
	schema:        "hobo.provider-auth/v1"
	mode:          "svid-federation"
	tokenAudience: "lakebed.deploy"
	exchange:      "hobo:brokered-deploy-token"
	staticSecrets: false
}

#DriverResourceRecord: {
	name:     string & !=""
	type:     =~"^lakebed:"
	provider: "lakebed"
	outputs: [...string] & !=[]
}

#DriverProgramRecord: {
	apiVersion:   "hobo.driver-program/v1"
	kind:         "driver-program"
	driver:       "lakebed-deploy"
	deploymentId: string & !=""
	capsule:      =~"^capsule/"
	resources: [...#DriverResourceRecord] & !=[]
}

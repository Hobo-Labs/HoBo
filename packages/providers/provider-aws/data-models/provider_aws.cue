package hobo

// CUE constraints for the AWS CloudProvider wire records. One constraint per
// protobuf message in provider_aws.proto.

#EquivalenceMapping: {
	class:           string & !=""
	port:            string & !=""
	resourceClass:   =~"^aws:"
	providerService: string & !=""
	features: [...string] & !=[]
}

#CapabilityManifestIndex: {
	schema:         "hobo.capability-manifest-index/v1"
	providerId:     "@hobo/provider-aws"
	manifestSchema: "hobo.capability-manifest/v1"
}

#CostFact: {
	port:             string & !=""
	sku:              =~"^aws\\."
	unit:             string & !=""
	marginalPrice:    =~"^[0-9]+\\.[0-9]+$"
	freeTierIncluded: uint
}

#AuthPosture: {
	schema:        "hobo.provider-auth/v1"
	mode:          "svid-federation"
	tokenAudience: "sts.amazonaws.com"
	exchange:      "sts:AssumeRoleWithWebIdentity"
	staticSecrets: false
}

#RealizedIacResource: {
	name:     string & !=""
	type:     =~"^aws:"
	provider: "aws"
	outputs: [...string] & !=[]
}

#RealizedIacProgram: {
	apiVersion:   "hobo.iac-program/v1"
	kind:         "iac-program"
	provider:     "pulumi"
	deploymentId: string & !=""
	stack:        =~"^aws/"
	resources: [...#RealizedIacResource] & !=[]
}

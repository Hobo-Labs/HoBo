package data_models

import "list"

// CUE constraints for provider_cloudflare.proto messages.

#EquivalenceMapping: {
	class:            string & !=""
	port:             "compute" | "kv" | "objectStore"
	resource_class:   string & =~"^cloudflare:"
	provider_service: string & !=""
	features:         [...string] & list.MinItems(1)
}

#CapabilityManifestIndex: {
	schema:          string & !=""
	provider_id:     string & !=""
	manifest_schema: "hobo.capability-manifest/v1"
}

#HelloBindleResource: {
	id:         string & !=""
	type:       "compute" | "kv" | "objectStore"
	class_name: string & !=""
	require:    [...string]
}

#HelloBindlePlan: {
	id:        string & !=""
	app:       "hello-bindle"
	env:       string & !=""
	provider:  "@hobo/provider-cloudflare"
	resources: [...#HelloBindleResource] & list.MinItems(1)
}

#PublishedManifest: {
	index: schema: "hobo.capability-manifest-index/v1"
	capabilities: schema: "hobo.capabilities/v1"
	auth: {
		schema:        "hobo.provider-auth/v1"
		staticSecrets: false
	}
	cost: {
		schema:   "hobo.cost/v1"
		currency: "USD"
		facts:    [...{sku: string, unit: string}] & list.MinItems(1)
	}
}

#EquivalenceClass: {
	class: "web/service" | "kv" | "objectStore"
	port: "compute" | "kv" | "objectStore"
	resourceClass: string & =~"^cloudflare:"
	providerService: string & !=""
	features: [...string] & list.MinItems(1)
}

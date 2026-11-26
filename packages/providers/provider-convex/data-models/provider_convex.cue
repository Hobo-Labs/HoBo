// CUE constraints for every protobuf type in provider_convex.proto, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package provider_convex

#ConvexEquivalenceClassRecord: {
	class:            "web/service" | "database/reactive" | "objectStore"
	port:             "compute" | "database" | "objectStore"
	resource_class:   =~"^convex:[a-z-]+$"
	provider_service: string & !=""
	features: [...string & !=""]
}

#ConvexCostFactRecord: {
	port:               string & !=""
	sku:                =~"^convex\\."
	unit:               string & !=""
	marginal_price:     =~"^[0-9]+\\.[0-9]+$"
	free_tier_included: uint64
}

#ConvexAuthRecord: {
	schema:         "hobo.provider-auth/v1"
	provider_id:    "@hobo/provider-convex"
	mode:           "deploy-key-brokered"
	token_audience: "convex.management"
	exchange:       "hobo:brokered-deploy-token"
	required_claims: [...string & !=""]
	static_secrets: false
}

#ConvexDriverResourceRecord: {
	name:     string & !=""
	type:     string & !=""
	provider: "@hobo/provider-convex"
	outputs: [...string & !=""]
}

#ConvexDriverProgramRecord: {
	api_version:   "hobo.driver-program/v1"
	kind:          "driver-program"
	driver:        "convex-deploy"
	deployment_id: string & !=""
	deployment:    string & !=""
	resources: [...#ConvexDriverResourceRecord]
}

#ConvexLimitsRecord: {
	query_mutation_ms:     1000
	document_bytes:        1048576
	action_ms:             600000
	transaction_write_cap: uint32 & >0
	paradigm:              "document"
}

#ConvexImpedanceFindingRecord: {
	code:     string & !=""
	severity: "info" | "warn" | "block"
	message:  string & !=""
}

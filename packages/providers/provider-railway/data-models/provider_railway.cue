// CUE constraints for every protobuf type in provider_railway.proto.
//
// The invariants worth writing down here are the ones a wrong answer at this
// boundary would violate: a port this provider cannot realize, a partial match
// that hides which feature is missing, a resource class from another provider,
// a `require`d option block (this package only ever prefers), and a temporary
// station "refusal" that quietly says it succeeded.

package provider_railway

import "list"

// Wire spellings, which are the strings the TypeScript actually exchanges. The
// protobuf zero slots (`*_UNSPECIFIED`) have no spelling here on purpose: an
// unnamed port is a contract change, not a fourth admissible port.
#RailwayPortKind: "compute" | "kv" | "queue"

#RailwayMatchKind: "full" | "partial" | "none"

// Only `prefer` is reachable from this package. `require` is spelled here
// because the enum admits it and a Camp-scoped policy may raise a block to it;
// no code path in src/ produces one.
#RailwayNegotiation: "prefer" | "require"

#RailwayResourceClass: =~"^railway:[a-z][a-z0-9-]*$"

// A plan name becomes a DNS label downstream (ADR-0130 named endpoints), so it
// is bounded here rather than at the hostname, where the failure would be a
// broken URL instead of a rejected plan.
#RailwayDnsLabel: =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"

#RailwayFeature: =~"^[a-z][a-z0-9-]*$"

#RailwayEquivalenceClass: {
	class_key:        "web/service" | "kv" | "queue"
	port:             #RailwayPortKind
	resource_class:   #RailwayResourceClass
	provider_service: string & !=""
	features: [...#RailwayFeature] & list.MinItems(1)

	// The equivalence table is the whole claim this provider makes, so the
	// three rows are pinned rather than merely well-formed. A row that maps
	// `kv` onto `railway:service` would make Matching promise Redis and get
	// a container.
	if class_key == "web/service" {
		port:           "compute"
		resource_class: "railway:service"
	}
	if class_key == "kv" {
		port:           "kv"
		resource_class: "railway:redis"
	}
	if class_key == "queue" {
		port:           "queue"
		resource_class: "railway:queue"
	}
}

#RailwayPortRequest: {
	port: #RailwayPortKind
	features: [...#RailwayFeature]
}

#RailwayCapabilityMatch: {
	kind: #RailwayMatchKind
	missing: [...#RailwayFeature]

	// A partial match that cannot say what is missing is unusable to a
	// planner, and a full/none match with leftovers is a lie about the same
	// question.
	if kind == "partial" {
		missing: list.MinItems(1)
	}
	if kind == "full" {
		missing: list.MaxItems(0)
	}
	if kind == "none" {
		missing: list.MaxItems(0)
	}
}

#RailwayCostSignal: {
	currency: "USD"
	sku:      =~"^railway:[a-z][a-z0-9-]*$"
	unit:     "request"

	// "0" is not a price. It is this package declining to publish one, which
	// is why it is pinned: a non-zero marginal price may only appear together
	// with dated COST_SOURCE provenance, which this package does not carry.
	marginal_price: "0"
	pricing_status: "unknown"
}

#RailwayResourcePlan: {
	name: #RailwayDnsLabel
	port: #RailwayPortKind
	require: [...#RailwayFeature]
	prefer: [...#RailwayFeature]
}

#RailwayDriverResource: {
	name:     #RailwayDnsLabel
	type:     #RailwayResourceClass
	provider: "railway"
}

#RailwayDriverProgram: {
	api_version: "hobo.driver-program/v1"
	driver:      "railway-deploy"

	// `realize` answers about exactly one plan, so exactly one resource comes
	// back. A multi-resource program from this call would mean the provider
	// invented topology the plan never asked for.
	resources: [...#RailwayDriverResource] & list.MinItems(1) & list.MaxItems(1)
}

#RailwayCapabilityEntry: {
	port: #RailwayPortKind
}

#RailwayCapabilitySet: {
	capabilities: [...#RailwayCapabilityEntry] & list.MinItems(1)
}

#RailwayManifestAuth: {
	// Deploy authority is brokered per operation; a static secret in a
	// manifest is the failure mode this field exists to forbid.
	exchange:       "hobo:brokered-deploy-token"
	static_secrets: false
}

#RailwayManifestCost: {
	// Empty until a dated COST_SOURCE exists for this provider. An unsourced
	// fact here would become ranking input for the dispatcher.
	facts: [...#RailwayCostSignal] & list.MaxItems(0)
}

#RailwayCapabilityManifest: {
	provider_id: "@hobo/provider-railway"
	published: [string]: string
	capabilities: #RailwayCapabilitySet
	auth:         #RailwayManifestAuth
	cost:         #RailwayManifestCost
}

#RailwayProviderDescriptor: {
	id: "@hobo/provider-railway"

	// Railway does expose regions; this package models none, so it claims the
	// single placeholder rather than a region it cannot honour.
	regions: ["global"]
	ports: [...#RailwayPortKind] & list.MinItems(1) & list.UniqueItems()
}

#RailwayTypedOptionBlock: {
	provider_id: "railway"
	port:        #RailwayPortKind
	option_name: "service" | "redis"
	negotiation: #RailwayNegotiation
	options: [string]: string

	// The two option blocks this package exposes are port-specific; a redis
	// block on the compute port would pin the wrong resource.
	if option_name == "service" {
		port: "compute"
	}
	if option_name == "redis" {
		port: "kv"
	}
}

#RailwayProviderClientBinding: {
	port:             #RailwayPortKind
	resource_class:   #RailwayResourceClass
	provider_service: string & !=""

	// Binding values are deploy outputs (hostnames, ids, refs). Anything
	// credential-shaped belongs in secret custody, so the value form is
	// bounded to a single printable line.
	bindings: [string]: =~"^[^\\x00-\\x1f]{0,2048}$"
}

#RailwayTemporaryStationRefusal: {
	provider_id: "railway"
	code:        "HOBO_TEMP_PROVISION_UNAVAILABLE"

	// The flag and the refusal are the same fact stated twice; letting them
	// disagree is exactly how an example ends up asking for a permanent token.
	supports_anonymous_temporary_deploy: false
	reason:                              string & !="" & =~"(?i)temporary"
}

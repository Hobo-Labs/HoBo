// CUE constraints for every protobuf type in provider_webernetes.proto.
//
// Two families of invariant matter here. The yard-boundary shapes are bounded
// the same way every provider's are: a port this yard can host, a match that
// names what it is missing, a driver program about exactly one plan. The
// station shapes are bounded by what makes the "anonymous, no token" claim
// true: the endpoint has to be *local*, it has to carry no credential in its
// authority, and its lifetime has to be finite.

package provider_webernetes

import (
	"list"
	"regexp"
	"strings"
)

#WebernetesPortKind: "compute" | "kv" | "queue"

#WebernetesMatchKind: "full" | "partial" | "none"

// Only `prefer` is reachable from this package; `require` is spelled because
// the enum admits it and a Camp policy may raise a block to it.
#WebernetesNegotiation: "prefer" | "require"

#WebernetesEndpointLocality: "loopback" | "private-network" | "overlay"

#WebernetesResourceClass: =~"^webernetes:[a-z][a-z0-9-]*$"

#WebernetesDnsLabel: =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"

#WebernetesFeature: =~"^[a-z][a-z0-9-]*$"

#WebernetesEquivalenceClass: {
	class_key:        "web/service" | "kv" | "queue"
	port:             #WebernetesPortKind
	resource_class:   #WebernetesResourceClass
	provider_service: string & !=""
	features: [...#WebernetesFeature] & list.MinItems(1)

	// The local yard hosts a pod, a KV, and a queue. Pinning the rows keeps a
	// future edit from mapping `kv` onto a pod and making Matching promise a
	// key-value store that is really a container.
	if class_key == "web/service" {
		port:           "compute"
		resource_class: "webernetes:pod"
	}
	if class_key == "kv" {
		port:           "kv"
		resource_class: "webernetes:kv"
	}
	if class_key == "queue" {
		port:           "queue"
		resource_class: "webernetes:queue"
	}

	// The local pod is not managed by anyone, so it must not claim to be. A
	// `managed` feature here would let a requirement that needs an operator
	// land on a developer laptop.
	if class_key == "web/service" {
		features: [...("http" | "container")]
	}
}

#WebernetesPortRequest: {
	port: #WebernetesPortKind
	features: [...#WebernetesFeature]
}

#WebernetesCapabilityMatch: {
	kind: #WebernetesMatchKind
	missing: [...#WebernetesFeature]

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

#WebernetesCostSignal: {
	currency: "USD"
	sku:      #WebernetesResourceClass
	unit:     "request"

	// Zero here is a real price, not a missing one: a local pod produces no
	// vendor invoice. That is why this provider may publish the fact at all.
	marginal_price: "0"
	pricing_status: "verified-zero"
}

#WebernetesResourcePlan: {
	name: #WebernetesDnsLabel
	port: #WebernetesPortKind
	require: [...#WebernetesFeature]
	prefer: [...#WebernetesFeature]
}

#WebernetesDriverResource: {
	name:     #WebernetesDnsLabel
	type:     #WebernetesResourceClass
	provider: "webernetes"
}

#WebernetesDriverProgram: {
	api_version: "hobo.driver-program/v1"
	driver:      "webernetes-deploy"
	resources: [...#WebernetesDriverResource] & list.MinItems(1) & list.MaxItems(1)
}

#WebernetesCapabilityEntry: {
	port: #WebernetesPortKind
}

#WebernetesCapabilitySet: {
	capabilities: [...#WebernetesCapabilityEntry] & list.MinItems(1)
}

#WebernetesManifestAuth: {
	// Local does not mean unauthenticated: the deploy path is still a brokered
	// exchange, and a static secret is still forbidden.
	exchange:       "hobo:brokered-deploy-token"
	static_secrets: false
}

#WebernetesManifestCost: {
	facts: [...#WebernetesCostSignal]
}

#WebernetesCapabilityManifest: {
	provider_id: "@hobo/provider-webernetes"
	published: [string]: string
	capabilities: #WebernetesCapabilitySet
	auth:         #WebernetesManifestAuth
	cost:         #WebernetesManifestCost
}

#WebernetesProviderDescriptor: {
	id: "@hobo/provider-webernetes"
	regions: ["global"]
	ports: [...#WebernetesPortKind] & list.MinItems(1) & list.UniqueItems()
}

#WebernetesTypedOptionBlock: {
	provider_id: "webernetes"
	port:        "compute"
	option_name: "pod"
	negotiation: #WebernetesNegotiation
	options: [string]: string
}

#WebernetesProviderClientBinding: {
	port:             #WebernetesPortKind
	resource_class:   #WebernetesResourceClass
	provider_service: string & !=""
	bindings: [string]: =~"^[^\\x00-\\x1f]{0,2048}$"
}

// -----------------------------------------------------------------------------
// Temporary Environment Station boundary
// -----------------------------------------------------------------------------

#WebernetesStationRequest: {
	// Station ids are opaque to this package but bounded: they end up in a
	// hostname slug, so a control character or a 4 KiB string is a rejection.
	// Ids like `station:home:cloudflare` are the common form.
	station_id: string & !="" & =~"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
}

#WebernetesStationDeployment: {
	// The untrusted half. Both are absolute URLs and nothing more is assumed
	// until #WebernetesLocalEndpoint has looked at them.
	station_url: string & !=""
	claim_url:   string & !=""
}

#WebernetesLocalEndpoint: {
	// Plain http is admissible because the local station is served by a dev
	// server on loopback; what is not admissible is a public host or an
	// authority carrying a credential.
	url:    =~"^https?://[^@\\s]+$"
	scheme: "http" | "https"

	// Lowercased by URL parsing, never carrying userinfo or a trailing dot.
	host:     =~"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$" | "[::1]"
	locality: #WebernetesEndpointLocality
	// The separately supplied host/scheme cannot relabel a public locator.
	_normalizedURL: strings.ToLower(url)
	_normalizedURL: =~"^\(scheme)://\(regexp.QuoteMeta(host))(:[0-9]+)?([/#?]|$)"

	// Loopback names are the ordinary case; `.hobo.localhost` is what the
	// an injected local host may emit, and a bare `.hobo` name is forbidden outright
	// (ADR-0130).
	if locality == "loopback" {
		host: "localhost" | "[::1]" | =~"\\.localhost$" | =~"^127\\.\(#WebernetesIPv4Octet)\\.\(#WebernetesIPv4Octet)\\.\(#WebernetesIPv4Octet)$"
	}
	if locality == "private-network" {
		host: =~"^(10\\.\(#WebernetesIPv4Octet)\\.\(#WebernetesIPv4Octet)\\.\(#WebernetesIPv4Octet)|172\\.(1[6-9]|2[0-9]|3[01])\\.\(#WebernetesIPv4Octet)\\.\(#WebernetesIPv4Octet)|192\\.168\\.\(#WebernetesIPv4Octet)\\.\(#WebernetesIPv4Octet))$"
	}
	if locality == "overlay" {
		host: =~"\\.hobo\\.test$"
	}
}

#WebernetesIPv4Octet: "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])"

#WebernetesTemporaryStationResult: {
	station_id: #WebernetesStationRequest.station_id
	station:    #WebernetesLocalEndpoint
	claim:      #WebernetesLocalEndpoint
	expires_at: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"

	// A temporary station with an unbounded lease is a permanent one. The TTL
	// is the shared 1h default from @hobo/core, and it is never zero.
	ttl_seconds: uint32 & >0 & <=86400
	provider_id: "webernetes"

	// Both flags are the reason this path exists: no account, no token, and a
	// lease that expires on its own.
	anonymous: true
	temporary: true
}

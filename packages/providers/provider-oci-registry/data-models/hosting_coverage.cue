// CUE constraints for hosting_coverage.proto (plan 0024, I14).
package provider_oci_registry

import "list"

#CoverageProductId: =~"^[a-z0-9][a-z0-9._/-]{0,127}$"

#TrafficOfferingId: "lb.lifecycle" | "lb.weighted" | "lb.health" | "lb.locality" |
	"edge.path" | "edge.header" | "edge.canary" | "dns.weighted" |
	"dns.failover" | "overlay.funnel" | "overlay.funnel.multi" |
	"inprocess.weighted" | "driver.route-bind" | "mesh.optional" |
	"observe.health" | "observe.location" | "resiliency.edge"

#UnresolvedHostingProduct: {
	productId:   #CoverageProductId
	reason:      string & =~"\\S"
	remediation: string & =~"\\S"
}

#AbsentTrafficOffering: {
	offeringId: #TrafficOfferingId
	reason:     string & =~"\\S"
}

#HostingCoverage: {
	contract:           "hobo.provider-hosting-coverage/v1"
	providerId:         "oci-registry"
	resolvedProductIds: ["oci-registry.image/v1"]
	unresolved: [...#UnresolvedHostingProduct]
	traffic:    #TrafficCoverage
}

#TrafficCoverage: {
	kind: "other"
	// A registry routes no workload traffic: nothing present, no fallback.
	offerings: []
	fallbacks: []
	// So the whole portable vocabulary (17 ids) is declared absent.
	absent: [...#AbsentTrafficOffering] & list.MinItems(17) & list.MaxItems(17)
}

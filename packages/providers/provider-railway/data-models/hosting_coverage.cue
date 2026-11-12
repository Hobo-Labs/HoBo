// CUE constraints for hosting_coverage.proto (plan 0024 WP13, I14).
package provider_railway

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
	providerId:         "railway"
	resolvedProductIds: [...#CoverageProductId] & list.UniqueItems()
	unresolved: [...#UnresolvedHostingProduct]
	traffic: {
		kind: "simple" | "cloudflare" | "funnel" | "vercel" | "lakebed" | "other"
		// At least the portable floor or a native offering: never nothing.
		offerings: [#TrafficOfferingId, ...#TrafficOfferingId] & list.UniqueItems()
		fallbacks: [...#TrafficOfferingId]
		// Present plus absent is the whole portable vocabulary (17 ids).
		absent: [...#AbsentTrafficOffering] & list.MinItems(17-len(offerings)) & list.MaxItems(17-len(offerings))
	}
}

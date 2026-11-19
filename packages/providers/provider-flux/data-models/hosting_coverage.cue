package hobo

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
	contract:   "hobo.provider-hosting-coverage/v1"
	providerId: "flux"
	resolvedProductIds: [...#CoverageProductId] & list.UniqueItems()
	unresolved: [...#UnresolvedHostingProduct]
	traffic: #TrafficCoverage
}

#TrafficCoverage: {
	kind: "simple" | "cloudflare" | "funnel" | "vercel" | "lakebed" | "other"
	offerings: *([]) | ([...#TrafficOfferingId] & list.UniqueItems())
	fallbacks: [...#TrafficOfferingId]
	absent: [...#AbsentTrafficOffering] & list.MinItems(17-len(offerings)) & list.MaxItems(17-len(offerings))
}

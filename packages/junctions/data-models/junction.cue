package data_models

#ConnectivityTier: int & >=0 & <=5

#TierName: "private-network" | "cross-region" | "private-interconnect" | "overlay-mesh" | "public-mtls"

#JunctionTopology: {
	name:         string & !=""
	member_yards: [...string & !=""]
}

#JunctionMemberManifest: {
	yard_name:    string & !=""
	provider_id:  string & !=""
	region:       string
	capabilities: [...#TierName]
	residency:    [...string & !=""]
}

#ResidencyConflict: {
	source_yard: string & !=""
	target_yard: string & !=""
	diagnostic:  string & !=""
}

#PeeringEdge: {
	id:          string & !=""
	source_yard: string & !=""
	target_yard: string & !=""
	tier:        #ConnectivityTier & >=1
	tier_level:  int & >=1 & <=5
}

#ConnectivityHalf: {
	edge_id:        string & !=""
	yard_name:      string & !=""
	peer_yard_name: string & !=""
	role:           "source" | "target"
	tier:           #ConnectivityTier & >=1
	tier_level:     int & >=1 & <=5
}

#DnsRecord: {
	record_name: string & !=""
	record_type: "CNAME" | "A"
	target:      string & !=""
	owner_yard:  string & !=""
}

#TrustAnchorExchange: {
	from_yard: string & !=""
	to_yard:   string & !=""
	// binary hobo.fleet.v1.WitnessedEnvelope; absent until from_yard publishes its trust record
	trust?: bytes
}

#PolicyPackDistribution: {
	to_yard:  string & !=""
	pack_ref: string & !=""
	signed:   true
}

#RegistryBundleDistribution: {
	from_yard:  string & !=""
	to_yard:    string & !=""
	bundle_ref: string & !=""
	signed:     true
}

#JunctionConnectivityPlan: {
	junction_name:    string & !=""
	members:          [...string & !=""]
	event_type:       "junction.PlanDerived"
	edges:            [...#PeeringEdge]
	dns_zone:         string & !=""
	dns_records:      [...#DnsRecord]
	trust_exchanges:  [...#TrustAnchorExchange]
	policy_packs:     [...#PolicyPackDistribution]
	registry_bundles: [...#RegistryBundleDistribution]
	residency_conflicts: [...#ResidencyConflict]
}

#YardConnectivityHalfPlan: {
	junction_name:          string & !=""
	yard_name:              string & !=""
	halves:                 [...#ConnectivityHalf]
	dns_records_to_realize: [...#DnsRecord]
	dns_records_to_resolve: [...#DnsRecord]
	trust_exchanges:        [...#TrustAnchorExchange]
	policy_packs:           [...#PolicyPackDistribution]
	registry_bundles:       [...#RegistryBundleDistribution]
}

// CUE constraints for every protobuf type in self_hosted_data_store.proto.
// The dependent rules pin the verdict to its evidence: `can` leaves nothing
// missing, `undetermined` names at least one missing facet.

package core

#SelfHostFacet: "long-running-compute" | "persistent-volume" | "inbound-tcp" | "operator-control"

#RegisteredComputeCapabilityRecord: {
	resource_class:   string & !=""
	provider_service: string & !=""
	features: [...string & !=""]
}

#RegisteredCatalogRowRecord: {
	profile:     string & !=""
	product_id?: string & !=""
}

#HostFormSourceRecord: {
	url:        string & =~"^https://"
	checked_at: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
	note:       string & !=""
}

#RegisteredHostFacetClaimRecord: {
	facet:  #SelfHostFacet
	holds:  bool
	detail: string & !=""
	sources: [#HostFormSourceRecord, ...#HostFormSourceRecord]
}

#RegisteredHostFormRecord: {
	product_id?:       string & !=""
	resource_class?:   string & !=""
	provider_service:  string & !=""
	form:              "vm" | "container"
	form_sources: [#HostFormSourceRecord, ...#HostFormSourceRecord]
	volume_product_id?: string & !=""
	facets: [...#RegisteredHostFacetClaimRecord]
}

#RegisteredHostDeclarationRecord: {
	provider_id: string & !=""
	compute: [...#RegisteredComputeCapabilityRecord]
	catalog: [...#RegisteredCatalogRowRecord]
	host_forms: [...#RegisteredHostFormRecord]
}

#SelfHostFormAssessmentRecord: {
	target:           string & !=""
	provider_service: string & !=""
	verdict:          "can" | "cannot" | "undetermined"
	findings: [...#SelfHostFacetFindingRecord]
	missing: [...#SelfHostFacet]
	caveats: [...string & !=""]
}

#SelfHostFacetFindingRecord: {
	facet:  #SelfHostFacet
	state:  "declared" | "undeclared" | "absent"
	reason: string & !=""
}

#SelfHostAssessmentRecord: {
	provider_id:     string & !=""
	verdict:         "can" | "cannot" | "undetermined"
	resource_class?: string & !=""
	findings: [...#SelfHostFacetFindingRecord]
	missing: [...#SelfHostFacet]
	caveats: [...string & !=""]
	forms: [...#SelfHostFormAssessmentRecord]
	summary: string & !=""
	if verdict == "can" {
		missing: []
	}
	if verdict == "undetermined" {
		missing: [#SelfHostFacet, ...#SelfHostFacet]
	}
}

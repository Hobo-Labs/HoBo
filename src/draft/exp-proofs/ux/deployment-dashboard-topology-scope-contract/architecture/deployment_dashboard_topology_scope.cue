// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#DeploymentDashboardTopologyScopeEvidenceKind: "unspecified" | "design-doc" | "contract-test" | "fixture" | "traceability"

#DeploymentDashboardTopologySurface: {
	id:                          string & !=""
	source:                      "event-projection"
	consumes:                    [...string]
	proves:                      string & !=""
	owns_runtime_implementation: false
}

#DeploymentDashboardTopologyEvidenceRequirement: {
	id:     string & !=""
	owner:  string & !=""
	mode:   #DeploymentDashboardTopologyScopeEvidenceKind
	source: string & !=""
	proves: string & !=""
}

#DeploymentDashboardTopologyBoundarySet: {
	service:  [...string]
	ux:       [...string]
	security: [...string]
	support:  [...string]
}

#DeploymentDashboardTopologyScopeRecord: {
	issue:              "HOBO-410"
	phase:              "M0"
	project:            "Deployment Dashboard & Topology Explorer"
	user_business_goal: string & !=""
	primary_personas:   [...string]
	owning_initiatives: [...string]
	design_refs:        [...string]
	adr_refs:           [...string]
	scope_in:           [...string]
	scope_out:          [...string]
	non_goals:          [...string]
	boundaries:         #DeploymentDashboardTopologyBoundarySet
	surface_taxonomy:   [...#DeploymentDashboardTopologySurface]
	m1_evidence:        [...#DeploymentDashboardTopologyEvidenceRequirement]
}

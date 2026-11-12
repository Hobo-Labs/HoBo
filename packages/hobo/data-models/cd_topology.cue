package hobo

// The package's fixture gate accepts each declared topology record
// (cd_topology.proto; src/cd-topology.ts parses them).
#CdTopology: #CdTopologyCamp | #CdTopologyYard

#CdTopologyName: string & =~"^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$"

#CdCampManagement: "CAMP_MANAGEMENT_UNSPECIFIED" | "CAMP_MANAGEMENT_MANAGED" | "CAMP_MANAGEMENT_OBSERVE_ONLY"

#CdTopologyCamp: {
	// `<yard>/<camp>`: a Yard-scoped id, never a bare Camp name.
	campId:     string & =~"^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)+$"
	yardId:     #CdTopologyName
	stationId?: string
	provider:   string & !=""
	regions?: [...string & !=""]
	envType: string & !=""
	labels?: {[string]: string}
	management?: #CdCampManagement
}

#CdTopologyYardCamp: {
	kind:    "camp"
	id:      string & !=""
	envType: string & !=""
	labels?: {[string]: string}
}

#CdTopologyYard: {
	kind:       "yard"
	contract:   "hobo.topology-objects/v1"
	name:       #CdTopologyName
	providerId: string & !=""
	regions?: [...string & !=""]
	labels?: {[string]: string}
	camps?: [...#CdTopologyYardCamp]
}

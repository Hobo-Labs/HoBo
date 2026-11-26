// CUE constraints for every protobuf type in data-models/status_page.proto.
// Constrains the customer-safe shape of status-page records; validation
// constraints only — rendering and folding live in src/.
package status_page

import (
	"list"
	"strings"
)

#StatusScopeKind: "station" | "primitives" | "project" | "bindle"

// UNKNOWN is the fail-safe: stale components must never read operational.
#ComponentStatus: "operational" | "maintenance" | "unknown" | "degraded" |
	"partial_outage" | "major_outage"

#IncidentState: "investigating" | "identified" | "monitoring" | "resolved"

#IncidentImpact: "minor" | "major" | "critical"

#MaintenanceState: "scheduled" | "in-progress" | "completed" | "canceled"

#StatusScope: {
	kind:  #StatusScopeKind
	id:    string & =~"^[a-z0-9][a-z0-9._-]*$"
	label: string & strings.MinRunes(1)
}

#ComponentSpec: {
	id:           string & =~"^[a-z0-9][a-z0-9._-]*$"
	label:        string & strings.MinRunes(1)
	kind:         "capability" | "primitive" | "app-kit" | "dependency" | "bindle" | "sidecar"
	description?: string
}

#DailyStatusRecord: {
	date:    string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
	worst:   #ComponentStatus
	samples: int & >=1
}

#ComponentStatusRecord: {
	spec:          #ComponentSpec
	status:        #ComponentStatus
	lastSignalAt?: string
	attainment?:   number & >=0 & <=1
	target?:       number & >0 & <=1
	history: [...#DailyStatusRecord] & list.MaxItems(90)
	delayed: bool
}

#IncidentUpdateRecord: {
	state:  #IncidentState
	body:   string & strings.MinRunes(1)
	at:     string & strings.MinRunes(1)
	public: bool
}

#IncidentRecord: {
	id:    string & =~"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
	title: string & strings.MinRunes(1)
	state: #IncidentState
	impact: #IncidentImpact
	affectedComponents: [...string]
	openedAt:    string & strings.MinRunes(1)
	updatedAt:   string & strings.MinRunes(1)
	resolvedAt?: string
	updates: [...#IncidentUpdateRecord]
	// Resolved incidents must carry resolvedAt.
	if state == "resolved" {
		resolvedAt: string & strings.MinRunes(1)
	}
}

#MaintenanceRecord: {
	id:          string & =~"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
	title:       string & strings.MinRunes(1)
	state:       #MaintenanceState
	windowStart: string & strings.MinRunes(1)
	windowEnd:   string & strings.MinRunes(1)
	affectedComponents: [...string]
	expectedImpact: string
}

#StatusPageSnapshot: {
	schema:             "hobo.status-page/v1"
	scope:              #StatusScope
	generatedAt:        string & strings.MinRunes(1)
	overallIndicator:   "none" | "minor" | "major" | "critical" | "maintenance" | "unknown"
	overallDescription: string & strings.MinRunes(1)
	components: [...#ComponentStatusRecord]
	activeIncidents: [...#IncidentRecord]
	recentIncidents: [...#IncidentRecord]
	maintenances: [...#MaintenanceRecord]
	freshnessBudgetMs: int & >=0
	staleComponentIds: [...string]
	contentHash?: string & =~"^sha256:[0-9a-f]{64}$"
}

#StatusPagePublished: {
	scopeKind:   #StatusScopeKind
	scopeId:     string & =~"^[a-z0-9][a-z0-9._-]*$"
	contentHash: string & =~"^sha256:[0-9a-f]{64}$"
	// Declared-public component allowlist — publishing requires at least one.
	components: [...string] & list.MinItems(1)
}

#StatusPageUnpublished: {
	scopeKind: #StatusScopeKind
	scopeId:   string & =~"^[a-z0-9][a-z0-9._-]*$"
	reason:    string & strings.MinRunes(1)
}

#StatusPageIncidentPosted: {
	incidentId:    string & =~"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
	currentStatus: #IncidentState
	body:          string & strings.MinRunes(1)
}

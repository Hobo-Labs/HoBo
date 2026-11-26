// CUE constraints for every protobuf type in proto/public_status_page.proto.
// These constrain the customer-safe shape of public status records at M0; they
// are validation constraints only and do not implement a live status page.
package public_status_page

import (
	"list"
	"strings"
)

// Customer-safe incident/maintenance lifecycle state.
#IncidentState: "investigating" | "identified" | "monitoring" | "resolved"

// A customer-readable component group on the public status page.
#StatusPageComponent: {
	id:        string & =~"^[a-z][a-z0-9-]*$"
	label:     string & strings.MinRunes(1)
	ownerLane: string & strings.MinRunes(1)
	evidence:  string & strings.MinRunes(1)
}

#IncidentOpened: {
	incidentId:          string & =~"^INC-[0-9]+$"
	affectedComponents: [...string] & list.MinItems(1)
	currentStatus:       #IncidentState
	nextUpdateCondition: string & strings.MinRunes(1)
}

#IncidentUpdated: {
	incidentId:          string & =~"^INC-[0-9]+$"
	currentStatus:       #IncidentState
	knownWorkaround:     string
	nextUpdateCondition: string & strings.MinRunes(1)
}

#IncidentResolved: {
	incidentId:        string & =~"^INC-[0-9]+$"
	resolutionSummary: string & strings.MinRunes(1)
	followupOwner:     string & strings.MinRunes(1)
}

#MaintenanceScheduled: {
	incidentId:         string & =~"^INC-[0-9]+$"
	windowStart:        string
	windowEnd:          string
	affectedComponents: [...string] & list.MinItems(1)
	expectedImpact:     string & strings.MinRunes(1)
}

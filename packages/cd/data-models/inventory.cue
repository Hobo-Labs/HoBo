// CUE constraints for the inventory records in cd.proto (WP22: D19, D20,
// I19). Values are protobuf JSON (camelCase fields, enum names, uint64 as
// decimal strings); proto3 JSON omits defaults, so most scalars are optional.
// Self-contained (no package clause):
// `cue vet -c -d '#CampStatusRecord' inventory.cue status.json`.
//
// Rules that need evaluation (Station-only derivation, NO_RUN signal counts,
// reserved taint keys per command, claims vs declared topology, a set needing
// a selector or ids) live in the parse boundaries and `deriveStatus`
// (src/inventory/); test/inventory/cue.test.ts checks that the two agree on
// everything CUE can express.

import (
	"list"
	"strings"
)

#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#Slug:      =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
#Key:       =~"^[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$"
#ClaimName: =~"^(label:)?[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$"
#Short:     string & strings.MaxRunes(256)
#Text:      string & strings.MaxRunes(1024)
#UInt64:    =~"^[0-9]+$"
#Principal: =~"^(user|agent|service|system|reconciler):.+$"
#Id:        string & !="" & strings.MaxRunes(256)

#CampManagement:    "CAMP_MANAGEMENT_UNSPECIFIED" | "CAMP_MANAGEMENT_MANAGED" | "CAMP_MANAGEMENT_OBSERVE_ONLY"
#CampConditionType: "CAMP_CONDITION_TYPE_READY" | "CAMP_CONDITION_TYPE_REACHABLE" | "CAMP_CONDITION_TYPE_LEASED" | "CAMP_CONDITION_TYPE_CREDENTIAL_VALID" | "CAMP_CONDITION_TYPE_CLAIMS_CONSISTENT" | "CAMP_CONDITION_TYPE_POSTURE_COMPLIANT"
#ConditionStatus:   "CONDITION_STATUS_TRUE" | "CONDITION_STATUS_FALSE" | "CONDITION_STATUS_UNKNOWN"
#SignalSource:      "SIGNAL_SOURCE_STATION" | "SIGNAL_SOURCE_RECONCILER" | "SIGNAL_SOURCE_HEALTH_SOURCE" | "SIGNAL_SOURCE_OPERATOR"
#TaintEffect:       "TAINT_EFFECT_NO_PLACE" | "TAINT_EFFECT_NO_RUN"
#EnrollmentState:   "ENROLLMENT_STATE_PENDING" | "ENROLLMENT_STATE_ACCEPTED" | "ENROLLMENT_STATE_REVOKED"

#SelectorRecord: {
	labels?: {[#Key]: #Short}
	envTypes?: [...#Id]
	jurisdictions?: [...#Id]
	campIds?: [...#Id]
	// Camp topology carries no Bindle: a Camp selector never names one.
	bindles?: []
}

// Every condition names its source (D19); recorded type and status are never UNSPECIFIED.
#CampConditionRecord: {
	type:    #CampConditionType
	status:  #ConditionStatus
	source:  #SignalSource
	reason?: #Text
	since?:  #Timestamp
}

// Observed, never trusted to grant (I19).
#CampClaimRecord: {
	name:        #ClaimName
	value?:      #Short
	reportedBy:  #Principal
	observedAt?: string
}

#TaintRecord: {
	key:     #Key
	value?:  #Short
	effect:  #TaintEffect
	source:  #SignalSource
	reason?: #Text
	addedBy: #Principal
	addedAt: #Timestamp
	// NO_RUN never comes from an agent self-report (D19).
	if effect == "TAINT_EFFECT_NO_RUN" {
		source: "SIGNAL_SOURCE_STATION" | "SIGNAL_SOURCE_HEALTH_SOURCE" | "SIGNAL_SOURCE_OPERATOR"
	}
}

#TolerationRecord: {
	key:     #Key
	value?:  #Short
	effect?: "TAINT_EFFECT_UNSPECIFIED" | #TaintEffect
	// 0 (omitted) tolerates indefinitely.
	tolerationMs?: #UInt64
}

#CampStatusRecord: {
	campId:      #Id
	management?: #CampManagement
	conditions?: [...#CampConditionRecord]
	claims?: [...#CampClaimRecord] & list.MaxItems(64)
	taints?: [...#TaintRecord]
	updatedAt?: #Timestamp
}

#CampSetRecord: {
	name:      #Slug
	selector?: #SelectorRecord
	campIds?: [...#Id] & list.UniqueItems()
	definedBy: #Principal
}

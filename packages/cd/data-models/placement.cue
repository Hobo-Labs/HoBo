// CUE constraints for the Placement records in cd.proto (WP22: D20, I18).
// Values are protobuf JSON (camelCase fields, enum names, uint64 as decimal
// strings). Self-contained (no package clause):
// `cue vet -c -d '#PlacementRecord' placement.cue placement.json`.
//
// Rules that need evaluation (score validity relative to now, minGroups vs
// count, unique names across lists of records) live in `parsePlacement` and
// `parseScoreSnapshot` (src/placement/); test/placement/cue.test.ts checks
// that the two agree on everything CUE can express.

import (
	"list"
	"strings"
)

#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#Digest:    =~"^sha256:[0-9a-f]{64}$"
#Slug:      =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
#Key:       =~"^[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$"
#ScoreName: =~"^[a-z0-9][a-z0-9._-]{0,62}$"
#Short:     string & strings.MaxRunes(256)
#Text:      string & strings.MaxRunes(1024)
#UInt64:    =~"^[0-9]+$"
#Principal: =~"^(user|agent|service|system):.+$"
#Percent:   int & >=0 & <=100
#Id:        string & !="" & strings.MaxRunes(256)

#TaintEffect: "TAINT_EFFECT_UNSPECIFIED" | "TAINT_EFFECT_NO_PLACE" | "TAINT_EFFECT_NO_RUN"

#SelectorRecord: {
	labels?: {[#Key]: #Short}
	envTypes?: [...#Id]
	jurisdictions?: [...#Id]
	campIds?: [...#Id]
	bindles?: []
}

#ReasonRecord: {
	code:        string & !=""
	message?:    #Text
	remediation: string & !="" & #Text
	subject?:    #Text
}

#SpreadConstraintRecord: {
	topologyKey: "yard" | "provider" | "region" | "jurisdiction" | =~"^label:[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$"
	minGroups?:  int & >=0
	maxGroups?:  int & >=0
	if minGroups != _|_ && maxGroups != _|_ {
		if maxGroups > 0 {
			maxGroups: >=minGroups
		}
	}
}

#ScoreWeightRecord: {
	score:   #ScoreName
	weight?: number
}

#ScoreSnapshotRecord: {
	score: #ScoreName
	byCamp: {[#Id]: number}
	validUntil: #Timestamp
	reportedBy: #Principal
	reportedAt: #Timestamp
	digest:     #Digest
}

#TolerationRecord: {
	key:           #Key
	value?:        #Short
	effect?:       #TaintEffect
	tolerationMs?: #UInt64
}

#PlacementGroupRecord: {
	name:            #Slug
	selector?:       #SelectorRecord
	maxSize?:        int & >=0
	maxSizePercent?: #Percent
}

#PlacementRecord: {
	schemaVersion: "hobo.cd.placement/v1"
	name:          #Slug & !~"^score-"
	campSets: [...#Slug] & list.MinItems(1) & list.UniqueItems()
	predicate?: #SelectorRecord
	requiredClaims?: [...=~"^(label:)?[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?(=.{0,256})?$"]
	// 0 (omitted) selects every eligible Camp; at most max_fanout_camps.
	count?: int & >=0 & <=1000
	spread?: [...#SpreadConstraintRecord]
	scores?: [...#ScoreWeightRecord]
	tolerations?: [...#TolerationRecord]
	groups?: [...#PlacementGroupRecord]
	defaultGroupSize?:        int & >=0
	defaultGroupSizePercent?: #Percent
	// One of the two sizes, never both.
	if defaultGroupSize != _|_ && defaultGroupSizePercent != _|_ {
		if defaultGroupSize > 0 {
			defaultGroupSizePercent: 0
		}
	}
	definedBy?: #Principal
}

#ExclusionCode: "taint-not-tolerated" | "claim-missing" | =~"^residency-conflict:[a-z-]+$" | "provider-not-approved" | "set-not-bound" | "observe-only" | "excluded" | "count-limit" | =~"^spread-max-groups:.+$"

#PlacementCandidateRecord: {
	campId:    #Id
	selected?: bool
	// Every exclusion has a code.
	exclusionCodes?: [...#ExclusionCode]
	score?: number
	if selected != _|_ {
		if selected {
			exclusionCodes?: []
		}
	}
}

#PlacementGroupDecisionRecord: {
	name:   #Slug
	index?: int & >=0
	campIds: [...#Id] & list.MinItems(1)
	mandatory?: bool
}

#PlacementDecisionRecord: {
	decisionId:      =~"^pd-[0-9a-f]{32}$"
	placement:       #Slug
	pipeline?:       string
	node?:           string
	inventoryDigest: #Digest
	scoreSnapshotDigests?: [...#Digest] & list.UniqueItems()
	groups: [...#PlacementGroupDecisionRecord] & list.MinItems(1)
	candidates: [...#PlacementCandidateRecord] & list.MinItems(1)
	reasons?: [...#ReasonRecord]
	decidedAt: #Timestamp
}

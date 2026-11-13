// CUE constraints for the change-window records in cd.proto (WP5: D10).
// Values are protobuf JSON (camelCase fields, enum names, uint64 as decimal
// strings). Self-contained (no package clause):
// `cue vet -c -d '#ChangeWindow' windows.cue window.json`.
//
// Rules that need evaluation (the RRULE subset in full, a known IANA zone,
// an occurrence with positive length, overrides within four hours of now)
// live in the parse boundary `compileWindow` / `createChangeWindows`
// (src/windows/); test/windows/cue.test.ts checks that the two agree on
// everything CUE can express.

import "strings"

#Slug:      =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"
#Text:      string & !="" & strings.MaxRunes(1024)
#UInt64:    =~"^[0-9]+$"

#SelectorRecord: {
	labels?: {[string & !=""]: string}
	envTypes?: [...string & !=""]
	jurisdictions?: [...string & !=""]
	campIds?: [...string & !=""]
	bindles?: [...string & !=""]
}

// One RRULE part of the accepted subset; COUNT/UNTIL exclusivity, value
// ranges and BYDAY ordinals are checked by `parseRrule`.
#RrulePart: =~"^(FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)|INTERVAL=[0-9]+|COUNT=[0-9]+|UNTIL=[0-9]{8}(T[0-9]{6}Z)?|BYDAY=[+-]?[0-9]{0,2}(MO|TU|WE|TH|FR|SA|SU)(,[+-]?[0-9]{0,2}(MO|TU|WE|TH|FR|SA|SU))*|BYMONTHDAY=[+-]?[0-9]{1,2}(,[+-]?[0-9]{1,2})*|BYMONTH=[0-9]{1,2}(,[0-9]{1,2})*|BYHOUR=[0-9]{1,2}(,[0-9]{1,2})*|BYMINUTE=[0-9]{1,2}(,[0-9]{1,2})*)$"
#Rrule:     =~"(^|;|:)FREQ=" & =~"^(RRULE:)?[A-Z]+=[^;]+(;[A-Z]+=[^;]+)*$"

#WindowKind: "WINDOW_KIND_ALLOW" | "WINDOW_KIND_FREEZE"

#ChangeWindowRecord: {
	name:      #Slug
	kind:      #WindowKind
	selector?: #SelectorRecord
	// RFC 5545 RRULE subset; absent means a single occurrence [startsAt, endsAt).
	rrule?:      #Rrule
	durationMs?: #UInt64
	// IANA time zone, e.g. America/Chicago.
	timezone:         =~"^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$"
	startsAt:         #Timestamp
	endsAt?:          #Timestamp
	rollbackAllowed?: bool
	definedBy?:       string
	// Each part of a rule is in the subset.
	if rrule != _|_ {
		_parts: [for part in strings.Split(strings.TrimPrefix(rrule, "RRULE:"), ";") {part & #RrulePart}]
	}
	// A single occurrence needs an end or a duration.
	if rrule == _|_ if durationMs == _|_ {
		endsAt: #Timestamp
	}
}

#ChangeWindow: #ChangeWindowRecord

#WindowOverrideRecord: {
	window: #Slug
	campIds: [string & !="", ...string & !=""]
	reason:      #Text
	decisionId?: string
	grantedBy?:  string
	expiresAt:   #Timestamp
}

#WindowOverride: #WindowOverrideRecord

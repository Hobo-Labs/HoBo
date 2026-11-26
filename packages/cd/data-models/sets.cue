// CUE constraints for the Sets/Deltas records in cd.proto (WP4).
// Field names follow the protobuf JSON mapping the journal stores. The TS
// parsers in src/sets/codec.ts (checkSet, checkDelta) apply the same rules.
package cd

#Sha256: =~"^sha256:[0-9a-f]{64}$"

#SetOrigin:
	"SET_ORIGIN_PROMOTION" |
	"SET_ORIGIN_UP" |
	"SET_ORIGIN_ROLLBACK" |
	"SET_ORIGIN_DRIFT_ADOPTION" |
	"SET_ORIGIN_TEARDOWN" |
	"SET_ORIGIN_LEGACY_FOLD" |
	"SET_ORIGIN_PREVIEW" |
	"SET_ORIGIN_CONFIG" |
	"SET_ORIGIN_TOPOLOGY" |
	"SET_ORIGIN_FAILOVER" |
	"SET_ORIGIN_POSTURE_REMEDIATION" |
	"SET_ORIGIN_DEPARTURE"

#ChangeKind: "CHANGE_KIND_ADD" | "CHANGE_KIND_UPDATE" | "CHANGE_KIND_REMOVE"

#DeltaIntent: "promote" | "rollback" | "drift-remediate" | "up" | "down" | "preview" | "config" | "topology" | "failover" | "depart" | "posture-remediate"

// An immutable, content-addressed desired state for one Camp. The resolved
// plan is never inlined: it lives in the artifact store under
// resolvedSetDigest (media type application/vnd.hobo.resolved-set+json).
#SetRecord: {
	schemaVersion:     "hobo.cd.set/v1"
	setId:             =~"^set_[0-9a-z]{8,64}$"
	tenant:            string & !=""
	environment?:      string
	campId:            string & !=""
	freightId?:        "" | #Sha256
	planHash:          #Sha256
	contentHash:       #Sha256
	predecessorSetId?: string
	// Every Set names the gate decision that admitted it (I10).
	gateDecisionId:    string & !=""
	origin:            #SetOrigin
	resolvedSetDigest: #Sha256
	// uint64 as a decimal string (protobuf JSON); a blob is never empty.
	resolvedSetBytes: =~"^[1-9][0-9]*$"
	createdAt:        string & !=""
}

#ResourceChange: {
	resource:    string & !=""
	kind:        #ChangeKind
	provider?:   string
	productId?:  string
	beforeHash?: "" | #Sha256
	afterHash?:  "" | #Sha256
	// An add has no before; a remove has no after.
	if kind == "CHANGE_KIND_ADD" {beforeHash?: ""}
	if kind == "CHANGE_KIND_REMOVE" {afterHash?: ""}
}

#DeltaRecord: {
	schemaVersion: "hobo.cd.delta/v1"
	// Set ids own the set_ prefix.
	deltaId:    =~"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" & !~"^set_"
	campId:     string & !=""
	baseSetId?: string
	freightId?: "" | #Sha256
	changes?: [...#ResourceChange]
	infrastructureDiff?: [...#ResourceChange]
	openedBy?: string
	proposal?: bool
	openedAt?: string
	intent:    #DeltaIntent
}

#DeltaDecisionRecord: {
	deltaId:         string & !=""
	setId?:          string
	gateDecisionId?: string
	reasons?: [...{
		code:         string & !=""
		message?:     string
		remediation?: string
		subject?:     string
	}]
	decidedAt?: string
}

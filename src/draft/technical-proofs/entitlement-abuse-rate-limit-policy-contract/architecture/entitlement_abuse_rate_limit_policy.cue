// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#EntitlementAbusePolicyEvidenceKind:
	"unspecified" |
	"design-record" |
	"contract-test" |
	"audit-fixture" |
	"support-handoff"

#EntitlementLimitType: {
	id:    string & !=""
	owner: string & !=""
}

#RateLimitBehavior: {
	id:               string & !=""
	customer_visible: bool
	audit_event:      string & !=""
	rule:             string & !=""
}

#AbuseResponse: {
	id:                     string & !=""
	audit_evidence:         [...string] & [_, _, ...]
	customer_communication: string & !=""
	recovery_path:          string & !=""
}

#BoundaryOwner: {
	id:    string & !=""
	owner: string & !=""
	rule:  string & !=""
}

#CustomerState: {
	id:                string & !=""
	support_visible:   bool
	recovery_required: bool
}

#AppealPolicy: {
	owner:           string & !=""
	required_fields: [...string] & [_, _, _, ...]
	rule:            string & !=""
}

#SupportOverride: {
	id:             string & !=""
	requires_audit: true
	requires_ttl:   bool
	owner:          string & !=""
}

#ScopeGuard: {
	id:              string & !=""
	forbidden_work:  string & !=""
	owning_boundary: string & !=""
}

#EntitlementAbusePolicyRecord: {
	issue:                "HOBO-491"
	phase:                "M0"
	limit_types:          [...#EntitlementLimitType] & [_, _, _, _, _, ...]
	rate_limit_behaviors: [...#RateLimitBehavior] & [_, _, _, _]
	response_matrix:      [...#AbuseResponse] & [_, _, _, _, _]
	boundaries:           [...#BoundaryOwner] & [_, _, _, _, _]
	customer_states:      [...#CustomerState] & [_, _, _, _, _]
	appeal_policy:        #AppealPolicy
	support_overrides:    [...#SupportOverride] & [_, _, _]
	scope_guards:         [...#ScopeGuard] & [_, _, _, _, _]
}

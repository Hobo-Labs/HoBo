// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#IncidentCommunicationEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "redaction-review" | "support-handoff" | "launch-claim-review"

#IncidentCommunicationScopeRecord: {
	issue:                  string & !=""
	summary:                string & !=""
	personas:               [...string]
	communication_surfaces: [...string]
	incident_states:        [...string]
	template_kinds:         [...string]
	evidence:               [...string]
}

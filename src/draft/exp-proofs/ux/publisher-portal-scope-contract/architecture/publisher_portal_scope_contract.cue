
package architecture_evidence

#PublisherPortalScopeEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "support-handoff" | "release-gate"

#PublisherPortalScopeRecord: {
	issue:         string & !=""
	project:       string & !=""
	phase:         "M0"
	summary:       string & !=""
	personas:      [...string]
	portal_states: [...string]
	m1_evidence:   [...string]
}

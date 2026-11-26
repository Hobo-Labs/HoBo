// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#DocsPortalScopeEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "security-review" | "support-handoff" | "release-gate"

#DocsPortalScopeRecord: {
	issue:                string & !=""
	project:              string & !=""
	phase:                "M0"
	summary:              string & !=""
	personas:             [...string]
	portal_content_areas: [...string]
	m1_evidence:          [...string]
}

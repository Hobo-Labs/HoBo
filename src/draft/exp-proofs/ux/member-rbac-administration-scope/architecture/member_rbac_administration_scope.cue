
package architecture_evidence

#MemberRbacAdministrationScopeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MemberRbacAdministrationScopeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

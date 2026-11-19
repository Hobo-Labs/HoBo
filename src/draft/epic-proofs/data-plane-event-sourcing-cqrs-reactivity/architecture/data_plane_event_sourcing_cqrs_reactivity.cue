
package architecture_evidence

#DataPlaneEventSourcingCqrsReactivityEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DataPlaneEventSourcingCqrsReactivityRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

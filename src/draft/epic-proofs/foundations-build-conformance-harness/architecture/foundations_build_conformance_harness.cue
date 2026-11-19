
package architecture_evidence

#FoundationsBuildConformanceHarnessEvidenceKind: "unspecified" | "design-record" | "contract-test"

#FoundationsBuildConformanceHarnessRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

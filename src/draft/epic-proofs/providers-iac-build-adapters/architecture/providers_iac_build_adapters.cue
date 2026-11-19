
package architecture_evidence

#ProvidersIacBuildAdaptersEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProvidersIacBuildAdaptersRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

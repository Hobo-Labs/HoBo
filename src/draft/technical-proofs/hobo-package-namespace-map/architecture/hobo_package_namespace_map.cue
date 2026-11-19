
package architecture_evidence

#HoboPackageNamespaceMapEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboPackageNamespaceMapRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

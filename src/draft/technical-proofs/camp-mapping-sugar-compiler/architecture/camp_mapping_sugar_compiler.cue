
package architecture_evidence

#CampMappingSugarCompilerEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CampMappingSugarCompilerRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

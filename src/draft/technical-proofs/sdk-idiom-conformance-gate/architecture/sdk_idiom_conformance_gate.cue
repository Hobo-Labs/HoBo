
package architecture_evidence

#SdkIdiomConformanceGateEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SdkIdiomConformanceGateRecord: {
	issue:         string & !=""
	summary:       string & !=""
	evidence:      [...string]
	requiredLanes: [...string] & [_, ...]
	helperClaims:  [...string]
}

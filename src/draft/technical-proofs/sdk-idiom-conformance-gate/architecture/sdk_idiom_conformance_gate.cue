// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#SdkIdiomConformanceGateEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SdkIdiomConformanceGateRecord: {
	issue:         string & !=""
	summary:       string & !=""
	evidence:      [...string]
	requiredLanes: [...string] & [_, ...]
	helperClaims:  [...string]
}

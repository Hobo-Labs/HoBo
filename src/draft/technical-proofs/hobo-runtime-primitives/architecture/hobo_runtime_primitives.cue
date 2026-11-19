
package architecture_evidence

#HoboRuntimePrimitivesEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboRuntimePrimitivesRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

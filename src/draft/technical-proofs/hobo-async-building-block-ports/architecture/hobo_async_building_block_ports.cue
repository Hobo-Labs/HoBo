
package architecture_evidence

#HoboAsyncBuildingBlockPortsEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboAsyncBuildingBlockPortsRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

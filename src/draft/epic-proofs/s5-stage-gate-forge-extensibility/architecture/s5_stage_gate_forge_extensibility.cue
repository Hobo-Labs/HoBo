// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#S5StageGateForgeExtensibilityEvidenceKind: "unspecified" | "design-record" | "contract-test"

#S5StageGateForgeExtensibilityRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

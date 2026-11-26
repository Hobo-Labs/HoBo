// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#S4StageGateMultiCloudContractEvidenceKind: "unspecified" | "drill-record" | "acceptance-attachment"

#S4StageGateMultiCloudContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

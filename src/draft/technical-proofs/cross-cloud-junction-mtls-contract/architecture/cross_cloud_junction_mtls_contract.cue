// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#CrossCloudJunctionMtlsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CrossCloudJunctionMtlsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

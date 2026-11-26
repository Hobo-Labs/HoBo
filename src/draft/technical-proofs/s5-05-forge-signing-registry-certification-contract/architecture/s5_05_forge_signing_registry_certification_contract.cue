// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#ForgeSigningRegistryCertificationEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ForgeSigningRegistryCertificationRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

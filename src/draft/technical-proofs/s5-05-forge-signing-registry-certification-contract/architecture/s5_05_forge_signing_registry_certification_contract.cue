
package architecture_evidence

#ForgeSigningRegistryCertificationEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ForgeSigningRegistryCertificationRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

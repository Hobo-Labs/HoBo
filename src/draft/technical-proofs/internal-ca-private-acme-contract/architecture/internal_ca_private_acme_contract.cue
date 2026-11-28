
package architecture_evidence

#InternalCaPrivateAcmeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#InternalCaPrivateAcmeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

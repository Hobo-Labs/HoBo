
package architecture_evidence

#AcmeDns01CertIssuanceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AcmeDns01CertIssuanceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

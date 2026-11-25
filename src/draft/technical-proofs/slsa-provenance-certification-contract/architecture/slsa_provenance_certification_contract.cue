
package architecture_evidence

#SlsaProvenanceCertificationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SlsaProvenanceCertificationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

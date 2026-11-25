
package architecture_evidence

#MeteringViewProjectionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MeteringViewProjectionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

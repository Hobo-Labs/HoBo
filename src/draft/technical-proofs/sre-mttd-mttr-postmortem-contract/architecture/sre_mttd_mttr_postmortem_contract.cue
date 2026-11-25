
package architecture_evidence

#SreMttdMttrPostmortemContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SreMttdMttrPostmortemContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

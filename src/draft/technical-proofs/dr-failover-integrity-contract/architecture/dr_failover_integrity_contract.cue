
package architecture_evidence

#DrFailoverIntegrityContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DrFailoverIntegrityContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

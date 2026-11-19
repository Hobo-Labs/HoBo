
package architecture_evidence

#PoisonEventQuarantineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PoisonEventQuarantineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

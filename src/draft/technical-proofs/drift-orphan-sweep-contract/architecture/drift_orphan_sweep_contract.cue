
package architecture_evidence

#DriftOrphanSweepContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DriftOrphanSweepContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

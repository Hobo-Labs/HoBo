
package architecture_evidence

#SnapshotCompactionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SnapshotCompactionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

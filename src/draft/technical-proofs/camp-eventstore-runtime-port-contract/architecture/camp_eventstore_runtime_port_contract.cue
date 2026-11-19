
package architecture_evidence

#CampEventstoreRuntimePortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CampEventstoreRuntimePortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

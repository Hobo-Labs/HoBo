
package architecture_evidence

#CrossCloudEquivalenceModelEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CrossCloudEquivalenceModelRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

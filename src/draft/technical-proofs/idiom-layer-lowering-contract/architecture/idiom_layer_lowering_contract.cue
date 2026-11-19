
package architecture_evidence

#IdiomLayerLoweringContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IdiomLayerLoweringContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#ChoreographySagaEngineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ChoreographySagaEngineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}


package architecture_evidence

#GenerationEvalMethodologySpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationEvalMethodologySpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

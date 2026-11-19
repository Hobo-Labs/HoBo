
package architecture_evidence

#ExperimentStatisticalAnalysisContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ExperimentStatisticalAnalysisContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

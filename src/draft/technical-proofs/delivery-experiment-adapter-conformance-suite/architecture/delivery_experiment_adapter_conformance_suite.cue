
package architecture_evidence

#DeliveryExperimentAdapterConformanceSuiteEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DeliveryExperimentAdapterConformanceSuiteRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

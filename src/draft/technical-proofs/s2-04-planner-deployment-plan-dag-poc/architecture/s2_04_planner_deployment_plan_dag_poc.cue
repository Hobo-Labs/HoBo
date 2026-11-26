// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#S2_04PlannerDeploymentPlanDagPocEvidenceKind: "unspecified" | "design-record" | "contract-test"

#S2_04PlannerDeploymentPlanDagPocRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

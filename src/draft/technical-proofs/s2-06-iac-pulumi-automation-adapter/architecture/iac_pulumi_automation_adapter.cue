// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#IacPulumiAutomationAdapterEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IacPulumiAutomationAdapterRecord: {
	issue:       string & !=""
	summary:     string & !=""
	evidence:    [...string]
	stack_model: "per-resource-stack"
}

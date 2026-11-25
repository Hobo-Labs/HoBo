
package architecture_evidence

#IfcHandlerTriggerContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IfcHandlerTriggerContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

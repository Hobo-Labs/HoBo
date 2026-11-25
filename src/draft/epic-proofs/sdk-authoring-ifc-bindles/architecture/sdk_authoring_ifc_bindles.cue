
package architecture_evidence

#SdkAuthoringIfcBindlesEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SdkAuthoringIfcBindlesRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
